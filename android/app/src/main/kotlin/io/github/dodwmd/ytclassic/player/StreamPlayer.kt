package io.github.dodwmd.ytclassic.player

import androidx.annotation.OptIn
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.formatSeconds
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
    var dragging by remember(video.id) { mutableStateOf<Float?>(null) }

    val player = remember(video.id) { ExoPlayer.Builder(context).build() }
    val scope = rememberCoroutineScope()

    fun load(at: Long, q: Int = quality) {
        error = null
        buffering = true
        val start = seek.restartAt(at)
        positionSec = start
        scope.launch {
            player.setMediaItem(MediaItem.fromUri(api.streamUrl(video.id, q, start, lang)))
            player.prepare()
            player.playWhenReady = true
        }
    }

    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying_: Boolean) {
                isPlaying = isPlaying_
            }

            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
            }

            override fun onPlayerError(e: PlaybackException) {
                buffering = false
                error = "Couldn't play this video (${e.errorCodeName})."
            }
        }
        player.addListener(listener)
        load(startSeconds)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) { player.pause() } // no background playback in v1

    LaunchedEffect(player) {
        while (true) {
            if (dragging == null) positionSec = seek.position(player.currentPosition)
            delay(500)
        }
    }

    Column(modifier) {
        Box(Modifier.fillMaxWidth().aspectRatio(16f / 9f).background(Color.Black)) {
            AndroidView(
                factory = { ctx -> PlayerView(ctx).apply { useController = false } },
                update = { it.player = player },
                modifier = Modifier.matchParentSize(),
            )
            if (buffering && error == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            error?.let { message ->
                Column(Modifier.align(Alignment.Center).padding(16.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(message, color = Color.White)
                    Button(onClick = { load(positionSec) }) { Text("Retry") }
                }
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { if (isPlaying) player.pause() else player.play() }) { Text(if (isPlaying) "❚❚" else "▶") }
            if (total > 0) {
                Slider(
                    value = dragging ?: positionSec.toFloat(),
                    onValueChange = { dragging = it },
                    onValueChangeFinished = {
                        dragging?.let { load(it.toLong()) }
                        dragging = null
                    },
                    valueRange = 0f..total.toFloat(),
                    modifier = Modifier.weight(1f),
                )
                Text("${formatSeconds((dragging ?: positionSec.toFloat()).toLong())} / ${formatSeconds(total)}", modifier = Modifier.padding(end = 8.dp))
            }
        }
        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            for (q in qualities) {
                FilterChip(selected = q == quality, onClick = { if (q != quality) { quality = q; load(positionSec, q) } }, label = { Text("${q}p") })
            }
        }
    }
}
