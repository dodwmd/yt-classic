package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage

/** A thumbnail with an optional duration badge, only loading https images (as the web frontend does). */
@Composable
fun Thumbnail(url: String, duration: String?, modifier: Modifier = Modifier, progress: Float? = null, watched: Boolean = false) {
    Box(modifier.aspectRatio(16f / 9f).clip(MaterialTheme.shapes.extraSmall).background(Color.Black)) {
        if (url.startsWith("https://")) AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
        if (!duration.isNullOrEmpty()) {
            Text(
                duration, color = Color.White, fontSize = 11.sp,
                modifier = Modifier.align(Alignment.BottomEnd).padding(4.dp).background(Color.Black.copy(alpha = 0.8f)).padding(horizontal = 4.dp),
            )
        }
        if (watched) {
            Text(
                "Watched", color = Color.White, fontSize = 11.sp,
                modifier = Modifier.align(Alignment.TopStart).padding(4.dp).background(Color.Black.copy(alpha = 0.8f)).padding(horizontal = 4.dp),
            )
        }
        // Decorative: the row's text says how much was watched, so TalkBack does not need the bar.
        if (progress != null && progress > 0f) {
            Box(Modifier.align(Alignment.BottomStart).fillMaxWidth().height(4.dp).background(Color.DarkGray).clearAndSetSemantics {}) {
                Box(Modifier.fillMaxWidth(progress).fillMaxHeight().background(LogoRed))
            }
        }
    }
}

/** One video in a list: thumbnail on the left, title and details on the right. */
@Composable
fun VideoRow(
    thumb: String,
    title: String,
    details: List<String>,
    duration: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    thumbWidth: Int = 160,
    progress: Float? = null,
    watched: Boolean = false,
) {
    Row(modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Thumbnail(thumb, duration, Modifier.width(thumbWidth.dp), progress, watched)
        Column(Modifier.weight(1f)) {
            Text(title, color = LinkBlue, fontWeight = FontWeight.Medium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            for (d in details.filter { it.isNotEmpty() }) Text(d, color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
fun SectionTitle(text: String, modifier: Modifier = Modifier) {
    Text(text, fontWeight = FontWeight.Bold, fontSize = 15.sp, modifier = modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp))
}
