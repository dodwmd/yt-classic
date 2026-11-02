package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.material3.Button
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import io.github.dodwmd.ytclassic.data.shortMessage
import io.github.dodwmd.ytclassic.data.showPlayer
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.formatViews
import io.github.dodwmd.ytclassic.data.joinParts
import io.github.dodwmd.ytclassic.data.timeAgo
import io.github.dodwmd.ytclassic.player.LocalPip
import io.github.dodwmd.ytclassic.player.StreamPlayer
import io.github.dodwmd.ytclassic.player.resumeStart

@Composable
fun WatchScreen(
    api: YtApi, id: String, startSeconds: Long, fullscreen: Boolean, onFullscreen: (Boolean) -> Unit,
    onVideo: (String) -> Unit, onChannel: (String) -> Unit,
) {
    // Leaving this screen (back, or opening another video) must not leave the app stuck in fullscreen.
    DisposableEffect(Unit) { onDispose { onFullscreen(false) } }
    // Survives leaving the screen and coming back (or the process being killed), so a detour doesn't lose your place.
    // A LongArray rather than state: it's written every few seconds and nothing should recompose for it.
    val resume = rememberSaveable(id) { longArrayOf(startSeconds) }
    val loaded = rememberLoad(id) { api.video(id) }
    LoadedContent(loaded) { r ->
        val v = r.video
        // Where this screen left off (also the explicit start), else where the server last saw it (any device).
        val begin = remember(v.id) { resumeStart(resume[0], r.progress, v.durationSeconds ?: 0L) }
        val inPip = LocalPip.current.inPip
        var expanded by remember(v.id) { mutableStateOf(false) }
        val later = rememberLater(api, (listOf(v.id) + r.related.items.map { it.id }).distinct())
        Column(Modifier.fillMaxWidth()) {
            // The player stays pinned at the top; everything else scrolls underneath it.
            // The server's "can't play" hint never hides the player for good: "Try anyway" mounts it (kept across recomposition).
            var override by rememberSaveable(v.id) { mutableStateOf(false) }
            if (showPlayer(r.playable, r.reason, override)) {
                StreamPlayer(v, r.quality, r.qualities, r.lang, begin, onPosition = { resume[0] = it }, fullscreen = fullscreen, onFullscreen = onFullscreen)
            } else {
                Column(Modifier.padding(12.dp).semantics { liveRegion = LiveRegionMode.Polite }) {
                    Text(shortMessage(r.message.ifBlank { "This video can't be played." }), color = MaterialTheme.colorScheme.error)
                    Button(onClick = { override = true }) { Text("Try anyway") }
                }
            }
            if (!fullscreen && !inPip) LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                item {
                    Column(Modifier.padding(12.dp)) {
                        Text(v.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                        WatchLaterButton(later, v.id, v.title)
                        Text(
                            joinParts(v.channelTitle, timeAgo(v.publishedAt), formatViews(v.views)),
                            color = LinkBlue,
                            modifier = Modifier.clickable(enabled = v.channelId.isNotEmpty()) { onChannel(v.channelId) }.padding(vertical = 6.dp),
                        )
                        if (v.description.isNotBlank()) {
                            Text(
                                v.description, color = Muted, maxLines = if (expanded) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.clickable { expanded = !expanded },
                            )
                        }
                    }
                }
                if (r.related.items.isNotEmpty()) item { SectionTitle(r.related.heading.ifBlank { "Related videos" }) }
                items(r.related.items, key = { it.id }) { RelatedRow(it, onVideo, thumbWidth = 140, later = later) }
            }
        }
    }
}
