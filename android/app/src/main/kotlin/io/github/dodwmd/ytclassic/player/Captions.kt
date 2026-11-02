package io.github.dodwmd.ytclassic.player

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import io.github.dodwmd.ytclassic.data.SettingsStore
import io.github.dodwmd.ytclassic.data.SubTrack
import io.github.dodwmd.ytclassic.data.YtApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import java.util.Locale

private const val TICK_MS = 200L
private const val NOTICE_MS = 3000L

/**
 * The state for one video, wired to the server and DataStore. Ticking follows playback: while playing (and the screen is
 * started) every 200 ms; when paused it is one lookup per change (a seek restart, new cues), not a loop.
 */
@Composable
fun rememberCaptions(api: YtApi, settings: SettingsStore, videoId: String, isPlaying: Boolean, pausedKey: Long, positionMs: () -> Long): CaptionsState {
    val state = remember(videoId) {
        CaptionsState(
            videoId,
            object : CaptionSource {
                override suspend fun tracks(videoId: String, pref: String): List<SubTrack> = api.subTracks(videoId, pref)
                override suspend fun vtt(videoId: String, lang: String): String = api.subVtt(videoId, lang)
            },
            object : CaptionPrefs {
                override suspend fun on() = settings.captionsOn.first()
                override suspend fun lang() = settings.captionsLang.first()
                override suspend fun save(on: Boolean, lang: String) = settings.setCaptions(on, lang)
            },
            deviceLang = Locale.getDefault().toLanguageTag(),
        )
    }
    LaunchedEffect(state) { state.start() }
    LaunchedEffect(state, state.tracks, state.enabled, state.lang, state.load) { state.loadCues() }
    LaunchedEffect(state, state.notice) {
        if (state.notice.isNotEmpty()) {
            delay(NOTICE_MS)
            state.clearNotice()
        }
    }
    val owner = LocalLifecycleOwner.current
    LaunchedEffect(state, state.cueVersion, state.enabled, isPlaying, if (isPlaying) 0L else pausedKey) {
        owner.repeatOnLifecycle(Lifecycle.State.STARTED) {
            state.tick(positionMs()) // always once: after a seek, a pause, new cues
            while (isPlaying && state.hasCues) {
                delay(TICK_MS)
                state.tick(positionMs())
            }
        }
    }
    return state
}

/**
 * The caption (or notice) text, bottom-centre over the video: white on translucent black so it reads on any picture and in both
 * themes. At most two lines; [lift] keeps it above the controls when they are laid over the picture (fullscreen).
 */
@Composable
fun CaptionOverlay(text: String, fullscreen: Boolean, lift: Dp, modifier: Modifier = Modifier) {
    if (text.isEmpty()) return
    Text(
        text, color = Color.White, textAlign = TextAlign.Center, maxLines = 2, overflow = TextOverflow.Ellipsis,
        fontSize = if (fullscreen) 20.sp else 15.sp, lineHeight = if (fullscreen) 26.sp else 20.sp,
        modifier = modifier.then(if (fullscreen) Modifier.windowInsetsPadding(WindowInsets.safeDrawing) else Modifier)
            .padding(start = 24.dp, end = 24.dp, bottom = lift + 8.dp, top = 8.dp)
            .clip(RoundedCornerShape(4.dp)).background(Color.Black.copy(alpha = 0.72f)).padding(horizontal = 8.dp, vertical = 2.dp),
    )
}
