package io.github.dodwmd.ytclassic.player

import android.content.Context
import android.content.Intent
import android.os.PowerManager
import android.net.Uri
import android.util.Log
import androidx.annotation.OptIn
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
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
import androidx.media3.common.VideoSize
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.HttpDataSource
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.exoplayer.source.SinglePeriodTimeline
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.AuthException
import io.github.dodwmd.ytclassic.data.NeedSubscriptionsException
import io.github.dodwmd.ytclassic.data.SettingsStore
import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.data.errorBodyOf
import io.github.dodwmd.ytclassic.data.shortMessage
import io.github.dodwmd.ytclassic.data.YtApi
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.min

/** Upper bound for ExoPlayer's buffer in bytes (about 48 MB). */
private const val BUFFER_BYTES = 48 * 1024 * 1024

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
class PlaybackHost(private val context: Context, private val api: YtApi, private val settings: SettingsStore) {
    /** The stream's origin and its `Authorization` value; set before each load. Read on ExoPlayer's loader thread. */
    @Volatile private var streamOrigin: String? = null
    @Volatile private var streamAuth: String? = null

    private val streamClient = streamClient()
    private val dataSources = DataSource.Factory { AuthDataSource(streamClient, { streamOrigin }, { streamAuth }) }

    // 4K streams buffer a lot per second: cap the buffer in bytes (and let that cap win over the time target) so a 1-2 GB device is not pushed out of memory.
    private val loadControl = DefaultLoadControl.Builder()
        .setTargetBufferBytes(BUFFER_BYTES)
        .setPrioritizeTimeOverSizeThresholds(false)
        .build()
    private val exo = ExoPlayer.Builder(context)
        .setLoadControl(loadControl)
        .setMediaSourceFactory(DefaultMediaSourceFactory(dataSources).setLoadErrorHandlingPolicy(StreamErrorPolicy()))
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
    private val reportLock = Mutex()
    private var lastReported = -1L // the last position sent to the server
    private var speedLoaded = false // the stored speed has been read (or the user chose one): it must not overwrite a newer choice
    private var screenAttached = false // the watch screen for [video] is in composition

    /** The video being played, or null when nothing is. Set by [open], cleared by [stop]. */
    var video by mutableStateOf<VideoDetail?>(null)
        private set
    var quality by mutableIntStateOf(0)
        private set
    /** The user is on Auto: [quality] is the tier Auto picked for this video. */
    var auto by mutableStateOf(false)
        private set
    /** This device's hardware decoders; read once (the query is not free: App warms it off the main thread at start). */
    val decoders: Decoders by lazy { deviceDecoders() }
    /** The chips the screen shows for the current video (set by the player UI); where a failing tier steps down to. */
    @Volatile var chips: List<Int> = emptyList()
    /** The tallest tier still allowed for this video: a tier this device failed to decode is not offered or retried. */
    var ceiling by mutableIntStateOf(Int.MAX_VALUE)
        private set
    /** Why the quality changed by itself (a tier the device could not decode), until the next choice. */
    var qualityNotice by mutableStateOf<String?>(null)
        private set
    /** The quality to remember once a frame of it has been shown (a tier that fails to start must not become the default). */
    private var pendingPref: Int? = null
    /** Playback speed (media time per real time); the persisted default, applied to every video. Pitch stays corrected (ExoPlayer's default). */
    var speed by mutableFloatStateOf(1f)
        private set
    var isPlaying by mutableStateOf(false)
        private set
    var buffering by mutableStateOf(false)
        private set
    var error by mutableStateOf<String?>(null)
        private set
    /** The current [error] is the server asking for (or rejecting) the access token: the UI offers Settings. */
    var needsToken by mutableStateOf(false)
        private set
    /** The backend's classified code for the current [error] (null when unclassified); drives the Retry button. */
    var errorCode by mutableStateOf<String?>(null)
        private set
    var errorRetryable by mutableStateOf(true)
        private set
    var finished by mutableStateOf(false)
        private set
    /** The decoded video's size (for the picture-in-picture shape); [VideoSize.UNKNOWN] before the first frame. */
    var videoSize by mutableStateOf(VideoSize.UNKNOWN)
        private set

    /** The running TV session (lean-back playback from the subscriptions), or null. See [startTv]. */
    var tv by mutableStateOf<TvSession?>(null)
        private set
    /** Why TV stopped by itself (too few subscriptions, repeated failures); shown on the TV screen until TV is started again. */
    var tvMessage by mutableStateOf<String?>(null)
        private set
    /** The current [tvMessage] is the server rejecting (or missing) the access token: the screen offers Settings. */
    var tvNeedsToken by mutableStateOf(false)
        private set
    private var tvTicker: Job? = null
    private var tvFetch: Job? = null
    private var tvWake: PowerManager.WakeLock? = null
    private var playedTicks = 0

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

    /**
     * Bumped wherever the inputs of [playIntent] (the player's playWhenReady, the pending restart and its wish) change,
     * so readers of [wantsToPlay] in a snapshot (the picture-in-picture parameters) are told about them.
     */
    private var intentVersion by mutableIntStateOf(0)

    /** Whether playback is meant to run: the pending restart's wish while one is pending, else the player's. */
    private val playIntent: Boolean get() = if (seek.restarting) pendingPlay else exo.playWhenReady

    /** Whether the user expects sound right now (not paused, not finished, not failed). Observable in a snapshot. */
    val wantsToPlay: Boolean get() = intentVersion >= 0 && video != null && error == null && (!finished || tv != null) && playIntent

    init {
        scope.launch { loadSpeed() } // so the speed button shows the stored speed before any video starts
        // While playing, tell the server every 10 s. Runs on the app scope, so it also works with the screen off.
        scope.launch {
            while (true) {
                delay(10_000)
                if (isPlaying && !seek.restarting) reportProgress()
            }
        }
        exo.addListener(object : Player.Listener {
            override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
                intentVersion++
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                this@PlaybackHost.isPlaying = isPlaying
                if (reportsOnPause(isPlaying, exo.playWhenReady, seek.restarting)) reportProgress() // paused or stopped
            }

            override fun onRenderedFirstFrame() {
                val p = pendingPref ?: return
                pendingPref = null
                scope.launch { settings.setQualityPref(p) } // app scope: outlives the watch screen
            }

            override fun onVideoSizeChanged(videoSize: VideoSize) {
                this@PlaybackHost.videoSize = videoSize
            }

            override fun onPlaybackStateChanged(state: Int) {
                buffering = state == Player.STATE_BUFFERING
                if (state == Player.STATE_ENDED) {
                    // A finished stream and one the backend cut short both end here; only the position tells them apart.
                    when (seek.endOutcome(exo.currentPosition)) {
                        StreamEnd.Stale -> return // the old stream, while a restart is pending
                        StreamEnd.CutShort -> error = "The stream stopped early."
                        StreamEnd.Finished -> {
                            finished = true
                            reportProgress(finished = true)
                        }
                    }
                    endIfDone()
                }
            }

            override fun onPlayerError(e: PlaybackException) {
                if (seek.restarting) return // the old stream failing doesn't matter, it is being replaced
                if (isDecoderFailure(e.errorCode)) {
                    // This device cannot decode the tier: step down one and carry on from here; a retry must not repeat it.
                    val lower = nextLowerChip(chips.filter { it <= ceiling }.ifEmpty { TIER_LIST.filter { it <= quality } }, quality)
                    if (lower != null) {
                        ceiling = lower
                        qualityNotice = "This device couldn't decode ${quality}p; switched to ${lower}p."
                        if (pendingPref != null) pendingPref = if (auto) AUTO_QUALITY else lower
                        return load(positionSeconds(), lower, play = true)
                    }
                }
                buffering = false
                val http = e.cause as? HttpDataSource.InvalidResponseCodeException
                needsToken = http?.responseCode == 401
                // Before any video bytes the stream route answers with the classified JSON error: say why it failed.
                val body = http?.takeIf { !needsToken }?.let { errorBodyOf(it.responseBody.decodeToString()) }
                errorCode = body?.code?.ifBlank { null }
                errorRetryable = body?.retryable ?: true
                error = when {
                    needsToken -> "Server needs an access token: set it in Settings."
                    body != null -> shortMessage(body.error) // the server's explanation, with or without a code
                    else -> "Couldn't play this video (${e.errorCodeName})."
                }
                endIfDone()
            }
        })
    }

    /** Applies the stored speed once, before the first stream is prepared (so there is no first second at 1x). */
    private suspend fun loadSpeed() {
        if (speedLoaded) return
        val stored = settings.playbackSpeed.first()
        if (!speedLoaded) applySpeed(stored)
        speedLoaded = true
    }

    private fun applySpeed(value: Float) {
        speed = clampSpeed(value)
        exo.setPlaybackSpeed(speed)
    }

    /** The user chose [value]: applies it (the player keeps it across stream restarts, and the session shows it) and keeps it as the global default. */
    fun changeSpeed(value: Float) {
        speedLoaded = true
        applySpeed(value)
        scope.launch { settings.setPlaybackSpeed(speed) } // app scope: outlives the watch screen
    }

    /** Starts [v] at [startSeconds], unless it is already the current video (the screen came back, or was recreated). */
    fun open(v: VideoDetail, initialQuality: Int, audioLang: String, startSeconds: Long, initialAuto: Boolean = false) {
        if (video?.id == v.id) return
        endTv() // the user chose a video themselves: nothing may take over when it ends
        begin(v, initialQuality, audioLang, startSeconds, auto = initialAuto)
        screenAttached = true
    }

    /** [handOver]: TV moving on to the next video; the old stream is not paused first, so the session never looks paused. */
    private fun begin(v: VideoDetail, initialQuality: Int, audioLang: String, startSeconds: Long, handOver: Boolean = false, auto: Boolean = this.auto) {
        ceiling = Int.MAX_VALUE
        qualityNotice = null
        pendingPref = null
        if (video != null) reportProgress() // switching videos: save where the previous one stopped
        lastReported = -1L
        video = v
        lang = audioLang
        seek = StreamSeek(v.durationSeconds ?: 0L, startSeconds)
        load(startSeconds, initialQuality, play = true, silence = !handOver, auto = auto)
    }

    /**
     * Starts TV: one video after another from the subscriptions, with no choices. The decisions live in [TvSession];
     * this does what it says. The next video is requested shortly before the current one ends so the hand-over has no
     * gap (the notification and service stay up). TV ends on [stopTv], when the screen is left, when the server says
     * there are too few subscriptions (after the current video), after [TV_MAX_FAILURES] failures in a row, when the
     * token is rejected, when background playback is off and the app is hidden, when the task is removed, or when the
     * user plays something else.
     */
    fun startTv() {
        if (tv != null) return
        if (video != null) stop()
        tvMessage = null
        tvNeedsToken = false
        val session = TvSession()
        tv = session
        screenAttached = true
        buffering = true
        tvTicker = scope.launch { tickTv(session) }
        tvPerform(session, session.onStart())
    }

    /** Opening the TV screen afresh: forget why the last session stopped. */
    fun clearTvMessage() {
        if (tv == null) {
            tvMessage = null
            tvNeedsToken = false
        }
    }

    /** Skip: leave the current video (its position is saved) and go to the next. */
    fun skipTv() {
        val session = tv ?: return
        if (!finished) reportProgress()
        tvPerform(session, session.onSkip())
    }

    /** Ends TV and playback. [message] is shown when TV stopped on its own. */
    fun stopTv(message: String? = null, needsToken: Boolean = false) {
        stop() // also ends the session
        tvMessage = message
        tvNeedsToken = needsToken
    }

    /** The TV screen was left with the app on screen: that is a stop. (In the background it plays on, like any video.) */
    fun leaveTv() {
        if (appVisible && tv != null) stopTv()
    }

    /** The task was swiped away: nothing may keep playing or start the next video. */
    fun taskRemoved() {
        if (tv != null) stopTv(TV_REMOVED_MESSAGE)
    }

    private fun endTv() {
        tv = null
        tvTicker?.cancel()
        tvFetch?.cancel()
        releaseTvWake()
    }

    private fun tvPerform(session: TvSession, step: TvStep) {
        if (tv !== session) return
        when (step) {
            TvStep.Wait -> {}
            is TvStep.Fetch -> fetchTv(session, step)
            is TvStep.Play -> {
                if (!canStartPlayback(appVisible, keepInBackground)) return stopTv(TV_BACKGROUND_MESSAGE)
                playedTicks = 0
                begin(step.pick.video, playableTier(step.pick.quality, decoders), "", 0, handOver = true, auto = step.pick.auto)
            }
            is TvStep.Stop -> stopTv(step.message, step.needsToken)
        }
    }

    private fun fetchTv(session: TvSession, step: TvStep.Fetch) {
        tvFetch?.cancel() // the session already ignores an older ticket's answer; this just saves the work
        if (!step.prefetch) buffering = true
        tvFetch = scope.launch {
            if (step.delayMs > 0) delay(step.delayMs)
            holdTvWake()
            val outcome = try {
                // The stored choice (or Auto) applies to TV too; once a video has played, its tier carries on.
                val wantAuto = if (quality > 0) auto else settings.qualityPref.first() == AUTO_QUALITY
                val wantQuality = when {
                    wantAuto -> AUTO_QUALITY
                    quality > 0 -> quality
                    else -> settings.qualityPref.first()
                }
                val d = withContext(Dispatchers.Default) { decoders }
                val r = api.tvNext(session.after, session.seen, wantQuality, min(screenShortSide(context), d.best), d.codecsParam)
                session.onFetched(step.ticket, TvPick(r.video, r.channelId.ifEmpty { r.video.channelId }, r.quality, wantAuto))
            } catch (e: CancellationException) {
                throw e
            } catch (e: AuthException) {
                session.onFetchFailed(step.ticket, TvFailure.Auth(e.message.orEmpty()))
            } catch (e: NeedSubscriptionsException) {
                session.onFetchFailed(step.ticket, TvFailure.NeedSubscriptions(e.message.orEmpty()))
            } catch (e: Exception) {
                session.onFetchFailed(step.ticket, TvFailure.Other(e.message ?: "Couldn't reach the server."))
            } finally {
                releaseTvWake()
            }
            tvPerform(session, outcome)
        }
    }

    /** Once a second: ask for the next video when the end is near, and notice that a video really played. */
    private suspend fun tickTv(session: TvSession) {
        while (true) {
            delay(1_000)
            if (tv !== session || !isPlaying || seek.restarting || seek.totalSeconds <= 0) continue
            if (++playedTicks >= TV_CONFIRM_SECONDS) session.onProgressed()
            if (wallSecondsLeft(seek.totalSeconds, positionSeconds(), speed) <= TV_PREFETCH_SECONDS) tvPerform(session, session.onNearEnd())
        }
    }

    // A short partial wake lock around the request for the next video, so a screen-off device cannot doze mid-hand-over.
    private fun holdTvWake() {
        val lock = tvWake ?: (context.getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "ytclassic:tv").apply { setReferenceCounted(false) }.also { tvWake = it }
        lock.acquire(30_000)
    }

    private fun releaseTvWake() {
        tvWake?.takeIf { it.isHeld }?.release()
    }

    /** The video failed to play (or the stream was cut short). */
    private fun tvFailed() {
        val session = tv ?: return
        tvPerform(session, session.onPlaybackFailed(error, auth = needsToken))
    }

    /**
     * Fire and forget: the server keeps the resume position and the history. A failure (offline, server down) is
     * ignored on purpose; it must never affect playback.
     */
    private fun reportProgress(finished: Boolean = false) {
        val v = video ?: return
        if (seek.totalSeconds <= 0) return // unknown length (live): there is nothing to resume
        val position = positionSeconds()
        if (!shouldReport(position, lastReported, finished)) return
        lastReported = position
        scope.launch {
            try {
                // One at a time and in order, so a slow timer post can never land after a newer pause post.
                reportLock.withLock { api.reportProgress(v.id, position, finished) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.d("PlaybackHost", "progress not saved: ${e.javaClass.simpleName}")
            }
        }
    }

    /** The user picked a quality chip ([auto]: the Auto chip, whose tier is [q]): restarts here at that tier; it becomes the default for new videos once it has played. */
    fun chooseQuality(q: Int, auto: Boolean) {
        if (q == quality && auto == this.auto) return
        qualityNotice = null
        // Remembered as the default only once a frame has been shown at this tier (see onRenderedFirstFrame).
        pendingPref = if (auto) AUTO_QUALITY else q
        load(positionSeconds(), q, auto = auto)
    }

    /** Absolute position in whole seconds. */
    fun positionSeconds(): Long = if (finished) seek.totalSeconds else seek.positionMs(exo.currentPosition) / 1000

    /**
     * Restarts the stream at [at] seconds, keeping the current play/pause state unless [play] says otherwise. The old
     * stream is silenced at once, the base offset only moves when the new stream is handed to the player, and only
     * the newest request may reach the player: a quick second seek must not be overtaken by the first.
     */
    fun load(at: Long, q: Int = quality, play: Boolean? = null, silence: Boolean = true, auto: Boolean = this.auto) {
        val v = video ?: return
        pendingPlay = play ?: playIntent
        intentVersion++
        quality = q
        this.auto = auto
        error = null
        errorCode = null
        needsToken = false
        finished = false
        buffering = true
        val start = seek.requestRestart(at)
        if (silence) exo.pause()
        startService()
        loading?.cancel()
        loading = scope.launch {
            try {
                val url = api.streamUrl(v.id, q, start, lang, decoders.codecsParam)
                streamOrigin = origin(url)
                streamAuth = api.streamAuthorization()
                loadSpeed()
                seek.commitRestart()
                exo.setMediaItem(item(v, url))
                exo.prepare()
                exo.playWhenReady = pendingPlay
                intentVersion++
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                seek.failRestart()
                intentVersion++
                buffering = false
                needsToken = e is AuthException
                errorCode = (e as? ApiException)?.code
                errorRetryable = (e as? ApiException)?.retryable ?: true
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
        if (seek.restarting) { pendingPlay = true; intentVersion++ } else exo.play()
    }

    fun pause() {
        pendingPlay = false
        intentVersion++
        exo.pause()
    }

    /** The app went to the background: pause unless background audio is on and something is playing. */
    fun onAppStopped() {
        if (tv != null && !keepInBackground) return stopTv(TV_BACKGROUND_MESSAGE) // it could not play on anyway
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
        endTv()
        if (!finished && !seek.restarting) reportProgress() // before the player is torn down
        loading?.cancel()
        seek.failRestart()
        intentVersion++
        exo.stop()
        exo.clearMediaItems()
        video = null
        videoSize = VideoSize.UNKNOWN
        isPlaying = false
        buffering = false
        error = null
        errorCode = null
        finished = false
        stopService()
    }

    /** Pause and remove the notification and service, but keep the video so the screen can offer Play/Replay/Retry. */
    fun endSession() {
        endTv() // the notification was dismissed: that is a stop for TV too
        exo.pause()
        stopService()
    }

    private fun endIfDone() {
        val session = tv
        if (session != null) { // TV: the end of a video is not the end of the session
            if (finished) tvPerform(session, session.onEnded()) else if (error != null) tvFailed()
            return
        }
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
