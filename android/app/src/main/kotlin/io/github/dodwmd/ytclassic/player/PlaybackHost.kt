package io.github.dodwmd.ytclassic.player

import android.content.Context
import android.content.Intent
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
        .build()
    private val scope = MainScope()
    private var seek = StreamSeek(0)
    private var loading: Job? = null
    private var restarting = false // a restart is pending: the player's own position still belongs to the old stream
    private var lang = ""

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
        override fun getCurrentPosition() = seek.positionMs(exo.currentPosition, restarting)
        override fun getContentPosition() = currentPosition
        override fun getBufferedPosition() = seek.positionMs(exo.bufferedPosition, restarting)
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
        override fun seekTo(positionMs: Long) = seekTo(0, positionMs)
        override fun seekTo(mediaItemIndex: Int, positionMs: Long) = load(positionMs / 1000)
        override fun seekForward() = seekTo(currentPosition + seekForwardIncrement)
        override fun seekBack() = seekTo(currentPosition - seekBackIncrement)
        override fun play() = this@PlaybackHost.play()
        override fun stop() = endSession() // the notification was dismissed
    }

    /** Whether the user expects sound right now (not paused, not finished, not failed). */
    val wantsToPlay: Boolean get() = video != null && error == null && !finished && exo.playWhenReady

    init {
        exo.addListener(object : Player.Listener {
            override fun onIsPlayingChanged(isPlaying: Boolean) {
                this@PlaybackHost.isPlaying = isPlaying
            }

            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                if (state == Player.STATE_ENDED) {
                    // A finished stream and one the backend cut short both end here; only the position tells them apart.
                    if (seek.endedEarly(exo.currentPosition)) error = "The stream stopped early." else finished = true
                    endIfDone()
                }
            }

            override fun onPlayerError(e: PlaybackException) {
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
        load(startSeconds, initialQuality)
    }

    /** Absolute position in whole seconds. */
    fun positionSeconds(): Long = if (finished) seek.totalSeconds else seek.positionMs(exo.currentPosition, restarting) / 1000

    /** Restarts the stream at [at] seconds. Only the newest request may reach the player: a quick second seek must not be overtaken by the first. */
    fun load(at: Long, q: Int = quality) {
        val v = video ?: return
        quality = q
        error = null
        finished = false
        buffering = true
        val start = seek.restartAt(at)
        restarting = true
        startService()
        loading?.cancel()
        loading = scope.launch {
            try {
                val url = api.streamUrl(v.id, q, start, lang)
                exo.setMediaItem(item(v, url))
                restarting = false
                exo.prepare()
                exo.playWhenReady = true
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                buffering = false
                error = e.message ?: "Couldn't start the stream."
                restarting = false
                endIfDone()
            }
        }
    }

    fun retry() = load(positionSeconds())

    fun play() {
        if (finished) return load(0)
        startService() // the session may have been dismissed while paused
        exo.play()
    }

    fun pause() = exo.pause()

    /** The app went to the background: pause unless background audio is on and something is playing. */
    fun onAppStopped() {
        if (!continuesInBackground(keepInBackground, wantsToPlay)) exo.pause()
    }

    /** The watch screen for [id] left composition. */
    fun leave(id: String) {
        if (video?.id == id && stopsOnLeavingScreen(appVisible, keepInBackground, wantsToPlay)) stop()
    }

    /** Forget the video and tear everything down, including the service and notification. */
    fun stop() {
        loading?.cancel()
        restarting = false
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
        if (endsSession(finished, error != null, appVisible)) endSession()
    }

    private fun startService() = context.startService(Intent(context, PlaybackService::class.java))
    private fun stopService() = context.stopService(Intent(context, PlaybackService::class.java))

    private fun item(v: VideoDetail, url: String) = MediaItem.Builder()
        .setUri(url)
        .setMediaMetadata(
            MediaMetadata.Builder()
                .setTitle(v.title)
                .setArtist(v.channelTitle)
                .setArtworkUri(v.thumb.takeIf { it.isNotBlank() }?.let(android.net.Uri::parse))
                .setDurationMs(seek.durationMs(C.TIME_UNSET))
                .build(),
        )
        .build()
}
