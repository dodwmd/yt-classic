package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.data.Chapter
import io.github.dodwmd.ytclassic.data.chapterIndexAt
import io.github.dodwmd.ytclassic.data.formatSeconds
import io.github.dodwmd.ytclassic.data.timestampRanges

/** The description with its timestamps as links (TalkBack lists them as links); a tap calls [seek] with the absolute second. */
@Composable
fun linkedDescription(text: String, duration: Long, enabled: Boolean, seek: (Long) -> Unit): AnnotatedString {
    val style = TextLinkStyles(SpanStyle(color = LinkBlue, textDecoration = TextDecoration.Underline))
    val seekNow by rememberUpdatedState(seek)
    // Without a player (unplayable video) a timestamp could not do anything, so it is not styled or announced as a link.
    return remember(text, duration, enabled, style) { buildAnnotatedString {
        if (!enabled) { append(text); return@buildAnnotatedString }
        var at = 0
        for (r in timestampRanges(text, duration)) {
            append(text.substring(at, r.from))
            withLink(LinkAnnotation.Clickable("t${r.seconds}", style) { seekNow(r.seconds) }) { append(text.substring(r.from, r.to)) }
            at = r.to
        }
        append(text.substring(at))
    } }
}

/** A collapsed "Chapters (N)" row that expands to one tappable row per chapter; the one playing at [now] is bold. */
fun LazyListScope.chaptersSection(chapters: List<Chapter>, open: Boolean, onToggle: () -> Unit, now: Long, seek: (Long) -> Unit) {
    if (chapters.isEmpty()) return
    item {
        Text(
            "Chapters (${chapters.size})", style = MaterialTheme.typography.titleSmall,
            modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClickLabel = if (open) "Collapse chapters" else "Expand chapters", role = Role.Button) { onToggle() }
                .padding(horizontal = 12.dp, vertical = 12.dp)
                .semantics { stateDescription = if (open) "Expanded" else "Collapsed" },
        )
    }
    if (!open) return
    val current = chapterIndexAt(chapters, now)
    items(chapters.size) { i ->
        val c = chapters[i]
        val here = i == current
        Row(
            Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(onClickLabel = "Go to ${c.title}") { seek(c.start) }.padding(horizontal = 12.dp, vertical = 8.dp)
                .semantics(mergeDescendants = true) { if (here) stateDescription = "Current chapter" },
        ) {
            Text(formatSeconds(c.start), color = LinkBlue, modifier = Modifier.padding(end = 12.dp))
            Text(c.title, fontWeight = if (here) FontWeight.Bold else FontWeight.Normal)
        }
    }
}
