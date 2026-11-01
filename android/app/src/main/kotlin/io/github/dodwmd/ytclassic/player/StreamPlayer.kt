package io.github.dodwmd.ytclassic.player

import androidx.annotation.OptIn
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.clickable
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
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.formatSeconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * Plays the backend's live stream. The stream can't be seeked, so seeking (slider, quality change, retry)
 * restarts it at the wanted offset through [StreamSeek]; the slider uses the real duration from the API.
 */
@OptIn(UnstableApi::class)
@Composable
fun StreamPlayer(
    api: YtApi,
    video: VideoDetail,
    initialQuality: Int,
    qualities: List<Int>,
    lang: String,
    startSeconds: Long,
    onPosition: (Long) -> Unit,
    fullscreen: Boolean,
    onFullscreen: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    val total = video.durationSeconds ?: 0L
    val seek = remember(video.id) { StreamSeek(total, startSeconds) }
    var quality by remember(video.id) { mutableIntStateOf(initialQuality) }
    var positionSec by remember(video.id) { mutableLongStateOf(seek.base) }
    var isPlaying by remember(video.id) { mutableStateOf(false) }
    var buffering by remember(video.id) { mutableStateOf(true) }
    var error by remember(video.id) { mutableStateOf<String?>(null) }
    var finished by remember(video.id) { mutableStateOf(false) }
    var dragging by remember(video.id) { mutableStateOf<Float?>(null) }

    var controlsVisible by remember(video.id) { mutableStateOf(true) }
    FullscreenEffect(fullscreen)
    BackHandler(enabled = fullscreen) { onFullscreen(false) }

    val player = remember(video.id) {
        ExoPlayer.Builder(context)
            // Take audio focus (pause for calls, duck for prompts, stop other media) and pause when headphones are unplugged.
            .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
            .setHandleAudioBecomingNoisy(true)
            .build()
    }
    val scope = rememberCoroutineScope()
    var loading by remember(video.id) { mutableStateOf<Job?>(null) }

    fun load(at: Long, q: Int = quality) {
        error = null
        finished = false
        buffering = true
        val start = seek.restartAt(at)
        positionSec = start
        // Only the newest request may reach the player: a quick second seek must not be overtaken by the first.
        loading?.cancel()
        loading = scope.launch {
            val url = api.streamUrl(video.id, q, start, lang)
            player.setMediaItem(MediaItem.fromUri(url))
            player.prepare()
            player.playWhenReady = true
        }
    }

    fun savePosition() = onPosition(if (finished) 0 else seek.position(player.currentPosition))

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying_: Boolean) {
                isPlaying = isPlaying_
            }

            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                if (state == Player.STATE_ENDED) {
                    // A finished stream and one the backend cut short both end here; only the position tells them apart.
                    if (seek.endedEarly(player.currentPosition)) {
                        positionSec = seek.position(player.currentPosition)
                        error = "The stream stopped early."
                    } else {
                        finished = true
                        positionSec = total
                    }
                }
            }

            override fun onPlayerError(e: PlaybackException) {
                buffering = false
                error = "Couldn't play this video (${e.errorCodeName})."
            }
        }
        player.addListener(listener)
        load(startSeconds)
        onDispose {
            savePosition()
            player.removeListener(listener)
            player.release()
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { // no background playback in v1
        player.pause()
        savePosition() // the process may be killed while we're in the background
    }

    LaunchedEffect(player) {
        while (true) {
            if (dragging == null && !finished) positionSec = seek.position(player.currentPosition)
            delay(500)
        }
    }

    val textColor = if (fullscreen) Color.White else LocalContentColor.current
    val transport: @Composable () -> Unit = {
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                onClick = { if (finished) load(0) else if (isPlaying) player.pause() else player.play() },
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = if (finished) "Replay" else if (isPlaying) "Pause" else "Play" },
            ) { PlayerIconView(if (finished) PlayerIcon.Replay else if (isPlaying) PlayerIcon.Pause else PlayerIcon.Play, textColor, iconSize = if (finished) 36.dp else 28.dp) }
            if (total > 0) {
                Slider(
                    value = dragging ?: positionSec.toFloat(),
                    onValueChange = { dragging = it },
                    onValueChangeFinished = {
                        dragging?.let { load(it.toLong()) }
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
            TextButton(
                onClick = { controlsVisible = true; onFullscreen(!fullscreen) }, // hidden controls must not outlive a fullscreen session
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = if (fullscreen) "Exit fullscreen" else "Fullscreen" },
            ) { PlayerIconView(if (fullscreen) PlayerIcon.ExitFullscreen else PlayerIcon.Fullscreen, textColor) }
        }
    }
    // One PlayerView for both layouts: movable content moves the same view instead of building a second one (the
    // surface may still redraw for a frame when it is re-attached).
    // The movable content below is remembered once per player, so Retry must reach the newest `load`.
    val retry by rememberUpdatedState { load(positionSec) }
    val videoView = remember(player) { movableContentOf { m: Modifier ->
        Box(m) {
            AndroidView(
                factory = { ctx -> PlayerView(ctx).apply { useController = false } },
                update = { it.player = player },
                modifier = Modifier.matchParentSize(),
            )
            if (buffering && error == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            error?.let { message ->
                Column(Modifier.align(Alignment.Center).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(message, color = Color.White)
                    Button(onClick = { retry() }) { Text("Retry") }
                }
            }
        }
    } }

    if (fullscreen) {
        // The video fills the screen; tap it to show or hide the controls laid over the bottom.
        Box(modifier.fillMaxSize().background(Color.Black)) {
            videoView(
                Modifier.fillMaxSize().clickable(
                    interactionSource = remember { MutableInteractionSource() }, indication = null,
                    role = Role.Button, onClickLabel = if (controlsVisible) "Hide controls" else "Show controls",
                ) { controlsVisible = !controlsVisible }.semantics { contentDescription = "Video" },
            )
            if (controlsVisible) {
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
                    FilterChip(selected = q == quality, onClick = { if (q != quality) { quality = q; load(positionSec, q) } }, label = { Text("${q}p") })
                }
            }
        }
    }
}
