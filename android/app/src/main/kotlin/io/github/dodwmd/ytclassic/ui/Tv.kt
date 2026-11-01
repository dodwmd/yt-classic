package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.player.PlaybackHost
import io.github.dodwmd.ytclassic.player.StreamPlayer

/**
 * TV: the player, what is playing now, and Skip and Stop. Nothing to choose. Playback lives in [PlaybackHost] (so it
 * continues in the background and across videos); this screen only shows it. Fullscreen carries over between videos
 * because the player stays composed while the video changes, and is left when TV stops. TV is only ever started by a
 * tap (Home's TV button, or Start TV here): a screen restored after the process was killed does not start it.
 */
@Composable
fun TvScreen(host: PlaybackHost, fullscreen: Boolean, onFullscreen: (Boolean) -> Unit, onExit: () -> Unit) {
    DisposableEffect(Unit) {
        onDispose {
            onFullscreen(false)
            host.leaveTv()
        }
    }
    val running = host.tv != null
    // TV ended (by itself, or Stop): nothing is left to be fullscreen about.
    LaunchedEffect(running) { if (!running) onFullscreen(false) }

    val v = host.video
    val message = host.tvMessage
    if (v != null && running) {
        Column(Modifier.fillMaxWidth()) {
            StreamPlayer(
                v, host.quality, emptyList(), "", 0, onPosition = {}, fullscreen = fullscreen, onFullscreen = onFullscreen,
                onSkip = if (fullscreen) ({ host.skipTv() }) else null, // the buttons below do it otherwise
                onStop = if (fullscreen) ({ host.stopTv(); onExit() }) else null,
            )
            if (!fullscreen) {
                Column(Modifier.padding(12.dp).semantics { liveRegion = LiveRegionMode.Polite }) {
                    Text("Now playing", style = MaterialTheme.typography.labelMedium, color = Muted)
                    Text(v.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(v.channelTitle, color = Muted)
                }
                Row(Modifier.padding(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Button(onClick = { host.skipTv() }) { Text("Skip") }
                    OutlinedButton(onClick = { host.stopTv(); onExit() }) { Text("Stop") }
                }
            }
        }
    } else {
        Column(Modifier.fillMaxSize().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            when {
                running -> CircularProgressIndicator() // waiting for the first video
                message != null -> {
                    Text(message, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                    if (host.tvNeedsToken) {
                        val openSettings = LocalOpenSettings.current
                        Button(onClick = openSettings, modifier = Modifier.padding(top = 12.dp)) { Text("Open Settings") }
                    }
                    Button(onClick = onExit, modifier = Modifier.padding(top = 12.dp)) { Text("Back to home") }
                }
                else -> {
                    Text("TV is not running.")
                    Button(onClick = { host.startTv() }, modifier = Modifier.padding(top = 12.dp)) { Text("Start TV") }
                    OutlinedButton(onClick = onExit, modifier = Modifier.padding(top = 8.dp)) { Text("Back to home") }
                }
            }
        }
    }
}
