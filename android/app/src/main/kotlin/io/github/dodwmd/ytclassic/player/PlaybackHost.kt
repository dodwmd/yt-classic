package io.github.dodwmd.ytclassic.player

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.Timeline
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.SinglePeriodTimeline
import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.data.YtApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.launch

/**
 * Owns the one ExoPlayer for the whole process, so playback outlives the watch screen (and the activity) while the
 * app is in the background. The UI reads the state below and calls the methods; [PlaybackService] wraps [player]
 * in a MediaSession for the notification, lock screen and headset buttons.
 *
 * The stream can't be seeked, so every seek, quality change and retry goes through [load], which restarts it at an
 * offset via [StreamSeek]. [player] is the same ExoPlayer seen with absolute positions/duration and seeks that
 * [load]; everything outside the app (the session) must use it rather than the raw ExoPlayer.
 */
@OptIn(UnstableApi::class)
class PlaybackHost(private val context: Context, private val api: YtApi) {
    private val exo = ExoPlayer.Builder(context)
        // Take audio focus (pause for calls, duck for prompts, stop other media) and pause when headphones are unplugged.
        .setAudioAttributes(AudioAttributes.Builder().setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
        .setHandleAudioBecomingNoisy(true)
        .setWakeMode(C.WAKE_MODE_NETWORK) // keep the CPU and Wi-Fi awake while streaming with the screen off
        .build()
    private val scope = MainScope()
    private var seek = StreamSeek(0)
    private var loading: Job? = null
    private var pendingPlay = false // whether the pending restart should start playing
    private var lang = ""
    private var screenAttached = false // the watch screen for [video] is in composition

    /** The video being played, or null when nothing is. Set by [open], cleared by [stop]. */
    var video by mutableStateOf<VideoDetail?>(null)
        private set
    var quality by mutableIntStateOf(0)
        private set
    var isPlaying by mutableStateOf(false)
        private set
    var buffering by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    var finished by mutableStateOf(false)
        private set

    /** Set by MainActivity: true while the app is on screen. */
    var appVisible = false
    /** The "Keep playing in the background" setting, mirrored from DataStore. */
    var keepInBackground = true

    private var timelineItem: MediaItem? = null
    private var timeline: Timeline = Timeline.EMPTY

    /** The player to hand to a PlayerView or MediaSession: absolute positions, restarting seeks. */
    val player: Player = object : ForwardingPlayer(exo) {
        override fun getCurrentPosition() = seek.positionMs(exo.currentPosition)
        override fun getContentPosition() = currentPosition
        override fun getBufferedPosition() = seek.positionMs(exo.bufferedPosition)
        override fun getContentBufferedPosition() = bufferedPosition
        override fun getDuration() = seek.durationMs(C.TIME_UNSET)
        override fun getContentDuration() = duration
        override fun isCurrentMediaItemSeekable() = seek.totalSeconds > 0
        override fun isCurrentMediaItemLive() = false // else the session reports no position at all
        override fun isCurrentMediaItemDynamic() = false
        // The raw stream's timeline has no length and isn't seekable (the session would then show no position),
        // so describe the real video: one seekable item of the API's duration.
        override fun getCurrentTimeline(): Timeline {
            val item = exo.currentMediaItem
            if (item == null || seek.totalSeconds <= 0) return super.getCurrentTimeline()
            if (item !== timelineItem) {
                timelineItem = item
                timeline = SinglePeriodTimeline(seek.totalSeconds * 1_000_000, true, false, false, null, item)
            }
            return timeline
        }
        override fun getAvailableCommands(): Player.Commands {
            val b = super.getAvailableCommands().buildUpon()
            if (seek.totalSeconds > 0) b.addAll(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD)
            return b.build()
        }
        override fun isCommandAvailable(command: Int) = availableCommands.contains(command)
        // Every seek variant restarts the stream (or does nothing): the raw player can't seek in it.
        override fun seekTo(positionMs: Long) = seekTo(0, positionMs)
        override fun seekTo(mediaItemIndex: Int, positionMs: Long) = load(positionMs / 1000)
        override fun seekForward() = seekTo(currentPosition + seekForwardIncrement)
        override fun seekBack() = seekTo(currentPosition - seekBackIncrement)
        override fun seekToDefaultPosition() = seekTo(0)
        override fun seekToDefaultPosition(mediaItemIndex: Int) = seekTo(0)
        override fun seekToPrevious() = seekTo(0)
        override fun seekToPreviousMediaItem() = seekTo(0)
        override fun seekToNext() {}
        override fun seekToNextMediaItem() {}
        override fun play() = this@PlaybackHost.play()
        override fun setPlayWhenReady(playWhenReady: Boolean) = if (playWhenReady) this@PlaybackHost.play() else this@PlaybackHost.pause()
        override fun stop() = endSession() // the notification was dismissed
    }

    /** Whether playback is meant to run: the pending restart's wish while one is pending, else the player's. */
    private val playIntent: Boolean get() = if (seek.restarting) pendingPlay else exo.playWhenReady

    /** Whether the user expects sound right now (not paused, not finished, not failed). */
    val wantsToPlay: Boolean get() = video != null && error == null && !finished && playIntent

    init {
        exo.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                this@PlaybackHost.isPlaying = isPlaying
            }

            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                if (state == Player.STATE_ENDED) {
                    // A finished stream and one the backend cut short both end here; only the position tells them apart.
                    when (seek.endOutcome(exo.currentPosition)) {
                        StreamEnd.Stale -> return // the old stream, while a restart is pending
                        StreamEnd.CutShort -> error = "The stream stopped early."
                        StreamEnd.Finished -> finished = true
                    }
                    endIfDone()
                }
            }

            override fun onPlayerError(e: PlaybackException) {
                if (seek.restarting) return // the old stream failing doesn't matter, it is being replaced
                buffering = false
                error = "Couldn't play this video (${e.errorCodeName})."
                endIfDone()
            }
        })
    }

    /** Starts [v] at [startSeconds], unless it is already the current video (the screen came back, or was recreated). */
    fun open(v: VideoDetail, initialQuality: Int, audioLang: String, startSeconds: Long) {
        if (video?.id == v.id) return
        video = v
        lang = audioLang
        seek = StreamSeek(v.durationSeconds ?: 0L, startSeconds)
        screenAttached = true
        load(startSeconds, initialQuality, play = true)
    }

    /** Absolute position in whole seconds. */
    fun positionSeconds(): Long = if (finished) seek.totalSeconds else seek.positionMs(exo.currentPosition) / 1000

    /**
     * Restarts the stream at [at] seconds, keeping the current play/pause state unless [play] says otherwise. The old
     * stream is silenced at once, the base offset only moves when the new stream is handed to the player, and only
     * the newest request may reach the player: a quick second seek must not be overtaken by the first.
     */
    fun load(at: Long, q: Int = quality, play: Boolean? = null) {
        val v = video ?: return
        pendingPlay = play ?: playIntent
        quality = q
        error = null
        finished = false
        buffering = true
        val start = seek.requestRestart(at)
        exo.pause()
        startService()
        loading?.cancel()
        loading = scope.launch {
            try {
                val url = api.streamUrl(v.id, q, start, lang)
                seek.commitRestart()
                exo.setMediaItem(item(v, url))
                exo.prepare()
                exo.playWhenReady = pendingPlay
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                seek.failRestart()
                buffering = false
                error = e.message ?: "Couldn't start the stream."
                endIfDone()
            }
        }
    }

    fun retry() = load(positionSeconds(), play = true)

    fun play() {
        if (!canStartPlayback(appVisible, keepInBackground)) return
        if (finished) return load(0, play = true)
        startService() // the session may have been dismissed while paused
        if (seek.restarting) pendingPlay = true else exo.play()
    }

    fun pause() {
        pendingPlay = false
        exo.pause()
    }

    /** The app went to the background: pause unless background audio is on and something is playing. */
    fun onAppStopped() {
        if (continuesInBackground(keepInBackground, wantsToPlay)) return
        pause()
        if (endsSessionOnAppStop(keepInBackground)) stopService() // no notification or headset button may resume it
    }

    /** The watch screen for [id] left composition. */
    fun leave(id: String) {
        if (video?.id != id) return
        screenAttached = false
        if (stopsOnLeavingScreen(appVisible, keepInBackground, wantsToPlay)) stop()
    }

    /** Forget the video and tear everything down, including the service and notification. */
    fun stop() {
        loading?.cancel()
        seek.failRestart()
        exo.stop()
        exo.clearMediaItems()
        video = null
        isPlaying = false
        buffering = false
        error = null
        finished = false
        stopService()
    }

    /** Pause and remove the notification and service, but keep the video so the screen can offer Play/Replay/Retry. */
    fun endSession() {
        exo.pause()
        stopService()
    }

    private fun endIfDone() {
        if (!endsSession(finished, error != null, appVisible)) return
        // Nobody is on the watch screen any more: forget the video so reopening it starts fresh, not on a stale overlay.
        if (screenAttached) endSession() else stop()
    }

    // Starting a service can be refused when the app is in the background; that must never crash playback.
    private fun startService() {
        try {
            context.startService(Intent(context, PlaybackService::class.java))
        } catch (e: RuntimeException) {
            Log.w("PlaybackHost", "Couldn't start the playback service: ${e.javaClass.simpleName}")
        }
    }

    private fun stopService() {
        context.stopService(Intent(context, PlaybackService::class.java))
    }

    private fun item(v: VideoDetail, url: String) = MediaItem.Builder()
        .setUri(url)
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(v.title)
                .setArtist(v.channelTitle)
                .setArtworkUri(v.thumb.takeIf { it.startsWith("https://") }?.let(Uri::parse)) // https only, as in the UI
                .setDurationMs(seek.durationMs(C.TIME_UNSET))
                .build(),
        )
        .build()
}
