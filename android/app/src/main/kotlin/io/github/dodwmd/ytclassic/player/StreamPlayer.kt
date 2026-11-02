package io.github.dodwmd.ytclassic.player

import androidx.annotation.OptIn
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.LocalContentColor
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.movableContentOf
import androidx.compose.ui.semantics.Role
import io.github.dodwmd.ytclassic.data.errorActions
import io.github.dodwmd.ytclassic.ui.LocalOpenSettings
import io.github.dodwmd.ytclassic.ui.classicSliderColors
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import android.graphics.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import io.github.dodwmd.ytclassic.App
import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.data.formatSeconds
import kotlinx.coroutines.delay

/**
 * The player UI for [video]. Playback itself lives in [PlaybackHost], so it can continue in the background; this
 * shows its state and sends the seek bar, quality and retry actions to it (which restart the stream at an offset
 * through [StreamSeek]; the slider uses the real duration from the API).
 */
@OptIn(UnstableApi::class)
@Composable
fun StreamPlayer(
    video: VideoDetail,
    initialQuality: Int,
    qualities: List<Int>,
    lang: String,
    startSeconds: Long,
    onPosition: (Long) -> Unit,
    fullscreen: Boolean,
    onFullscreen: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    /** TV: adds Skip and Stop buttons to the controls (used in fullscreen, where the buttons below the player are not visible). */
    onSkip: (() -> Unit)? = null,
    onStop: (() -> Unit)? = null,
) {
    val host = (LocalContext.current.applicationContext as App).host
    val total = video.durationSeconds ?: 0L
    var positionSec by remember(video.id) { mutableLongStateOf(startSeconds) }
    var dragging by remember(video.id) { mutableStateOf<Float?>(null) }
    val isPlaying = host.isPlaying
    val finished = host.finished
    val quality = host.quality

    var controlsVisible by remember(video.id) { mutableStateOf(true) }
    val pip = LocalPip.current
    // The small window has no orientation lock or hidden bars; both come back when it is expanded.
    FullscreenEffect(fullscreen && !pip.inPip)
    BackHandler(enabled = fullscreen) { onFullscreen(false) }

    fun savePosition() { if (host.video?.id == video.id) onPosition(if (host.finished) 0 else host.positionSeconds()) }

    DisposableEffect(pip) { onDispose { pip.clearVideoBounds() } }
    DisposableEffect(video.id) {
        host.open(video, initialQuality, lang, startSeconds)
        onDispose {
            savePosition()
            host.leave(video.id) // stops, unless it is playing on in the background
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) {
        host.onAppStopped() // pauses unless background audio is on and playing
        savePosition() // the process may be killed while we're in the background
    }

    LaunchedEffect(video.id) {
        while (true) {
            if (dragging == null && host.video?.id == video.id) positionSec = host.positionSeconds()
            delay(500)
        }
    }

    val textColor = if (fullscreen) Color.White else LocalContentColor.current
    val transport: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = { if (isPlaying) host.pause() else host.play() },
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = if (finished) "Replay" else if (isPlaying) "Pause" else "Play" },
            ) { PlayerIconView(if (finished) PlayerIcon.Replay else if (isPlaying) PlayerIcon.Pause else PlayerIcon.Play, textColor, iconSize = if (finished) 36.dp else 28.dp) }
            if (total > 0) {
                Slider(
                    value = dragging ?: positionSec.toFloat(),
                    onValueChange = { dragging = it },
                    onValueChangeFinished = {
                        dragging?.let { host.load(it.toLong()) }
                        dragging = null
                    },
                    valueRange = 0f..total.toFloat(),
                    colors = classicSliderColors(overVideo = fullscreen),
                    modifier = Modifier.weight(1f).semantics {
                        contentDescription = "Seek"
                        stateDescription = "${formatSeconds((dragging ?: positionSec.toFloat()).toLong())} of ${formatSeconds(total)}"
                    },
                )
                Text("${formatSeconds((dragging ?: positionSec.toFloat()).toLong())} / ${formatSeconds(total)}", color = textColor, modifier = Modifier.padding(horizontal = 8.dp))
            }
            if (onSkip != null) TextButton(onClick = onSkip, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)) { Text("Skip", color = textColor) }
            if (onStop != null) TextButton(onClick = onStop, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)) { Text("Stop", color = textColor) }
            if (pip.available) TextButton(
                onClick = pip.enter,
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = "Picture in picture" },
            ) { PlayerIconView(PlayerIcon.Pip, textColor) }
            TextButton(
                onClick = { controlsVisible = true; onFullscreen(!fullscreen) }, // hidden controls must not outlive a fullscreen session
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = if (fullscreen) "Exit fullscreen" else "Fullscreen" },
            ) { PlayerIconView(if (fullscreen) PlayerIcon.ExitFullscreen else PlayerIcon.Fullscreen, textColor) }
        }
    }
    // One PlayerView for both layouts: movable content moves the same view instead of building a second one (the
    // surface may still redraw for a frame when it is re-attached).
    val videoView = remember(host) { movableContentOf { m: Modifier ->
        Box(m.onGloballyPositioned {
            val r = it.boundsInWindow()
            // The picture inside the view (not the black bars), as the transition's source.
            val size = host.videoSize
            val f = fittedRect(r.left.toInt(), r.top.toInt(), r.width.toInt(), r.height.toInt(), pipAspect(size.width, size.height, size.pixelWidthHeightRatio))
            pip.setVideoBounds(Rect(f.left, f.top, f.right, f.bottom))
        }) {
            AndroidView(
                factory = { ctx -> PlayerView(ctx).apply { useController = false } },
                update = { it.player = host.player },
                onRelease = { it.player = null },
                modifier = Modifier.matchParentSize(),
            )
            if (host.buffering && host.error == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            host.error?.let { message ->
                Column(
                    Modifier.align(Alignment.Center).verticalScroll(rememberScrollState()).padding(16.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite }, // TalkBack reads why playback failed
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(message, color = Color.White)
                    if (host.needsToken && !pip.inPip) {
                        val openSettings = LocalOpenSettings.current
                        Button(onClick = openSettings) { Text("Open Settings") }
                    }
                    val actions = errorActions(host.errorCode, host.errorRetryable)
                    actions.hint?.let { Text(it, color = Color.White.copy(alpha = 0.8f)) }
                    if (actions.showRetry && !pip.inPip) Button(onClick = { host.retry() }) { Text("Retry") }
                }
            }
        }
    } }

    if (fullscreen || pip.inPip) {
        // The video fills the screen; tap it to show or hide the controls laid over the bottom.
        Box(modifier.fillMaxSize().background(Color.Black)) {
            videoView(
                // In the small window the system owns taps (they show its own buttons): no click target there.
                if (pip.inPip) Modifier.fillMaxSize() else Modifier.fillMaxSize().clickable(
                    interactionSource = remember { MutableInteractionSource() }, indication = null,
                    role = Role.Button, onClickLabel = if (controlsVisible) "Hide controls" else "Show controls",
                ) { controlsVisible = !controlsVisible }.semantics { contentDescription = "Video" },
            )
            if (controlsVisible && !pip.inPip) {
                Column(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color.Black.copy(alpha = 0.7f))
                        .windowInsetsPadding(WindowInsets.safeDrawing),
                ) { transport() }
            }
        }
    } else {
        Column(modifier) {
            // In landscape a full-width 16:9 box would fill the screen; cap its height so the details stay reachable.
            val maxHeight = with(LocalDensity.current) { (LocalWindowInfo.current.containerSize.height * 0.6f).toDp() }
            Box(Modifier.fillMaxWidth().background(Color.Black), contentAlignment = Alignment.Center) {
                videoView(Modifier.heightIn(max = maxHeight).aspectRatio(16f / 9f))
            }
            transport()
            Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (q in qualities) {
                    FilterChip(selected = q == quality, onClick = { if (q != quality) host.load(host.positionSeconds(), q) }, label = { Text("${q}p") })
                }
            }
        }
    }
}
