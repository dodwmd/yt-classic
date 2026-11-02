package io.github.dodwmd.ytclassic.player

import io.github.dodwmd.ytclassic.data.VideoDetail

/** TV is available from this many subscriptions (the server enforces it too). */
const val TV_MIN_SUBS = 5

/** Consecutive failures (no video found, or one that would not play) after which TV stops. */
const val TV_MAX_FAILURES = 3

/** How many recently played ids are sent with each request so they are not picked again. */
const val TV_SEEN = 50

/** The next video is requested this many seconds before the current one ends, so the hand-over has no gap. */
const val TV_PREFETCH_SECONDS = 15

/** Seconds a video must really play before the failure streak counts as over. */
const val TV_CONFIRM_SECONDS = 5

/** Null when TV can be turned on with [have] subscriptions, else the reason, e.g. "Subscribe to 2 more channels to turn on TV". */
fun tvNeedMessage(have: Int, need: Int = TV_MIN_SUBS): String? {
    val more = need - have
    return if (more <= 0) null else "Subscribe to $more more channel${if (more == 1) "" else "s"} to turn on TV"
}

fun tvFailureMessage(cause: String?): String = "TV stopped after $TV_MAX_FAILURES failures in a row${cause?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: ""}"

/** TV stopped because the server says there are too few subscriptions now. */
fun tvNeedStopMessage(serverMessage: String): String = "TV stopped. ${serverMessage.trimEnd('.')}."

const val TV_BACKGROUND_MESSAGE = "TV stopped when the app left the screen (background playback is off in Settings)."
const val TV_REMOVED_MESSAGE = "TV stopped because the app was closed."

/** A video the server picked, with the quality it suggests. */
data class TvPick(val video: VideoDetail, val channelId: String, val quality: Int, val auto: Boolean = false)

/** Why a request for the next video failed. */
sealed interface TvFailure {
    val message: String

    /** The server wants more subscriptions than there are now. */
    data class NeedSubscriptions(override val message: String) : TvFailure

    /** The server needs (or rejected) the access token: retrying cannot help. */
    data class Auth(override val message: String) : TvFailure

    data class Other(override val message: String) : TvFailure
}

/** What the host must do after an event. The session never does anything itself. */
sealed interface TvStep {
    /** Nothing. */
    data object Wait : TvStep

    /** Ask the server for the next video, then report the outcome with [ticket]; after [delayMs] if non-zero. */
    data class Fetch(val ticket: Int, val prefetch: Boolean, val delayMs: Long = 0) : TvStep

    /** Start this video now (the session has already recorded it as started). */
    data class Play(val pick: TvPick) : TvStep

    /** End TV, with the reason to show, if any. */
    data class Stop(val message: String?, val needsToken: Boolean = false) : TvStep
}

/**
 * The state and decisions of one TV session, with no Android in it. [PlaybackHost] feeds it events (a video ended, was
 * skipped, failed, a request returned...) and does what the returned [TvStep] says. Rules it enforces:
 * - only one request counts at a time: a response for an old ticket (after Skip, a failure, Stop) is ignored;
 * - the next video may be requested early ([onNearEnd]) and is held until the current one ends or is skipped;
 * - "too few subscriptions" found by that early request stops TV only after the current video ends; found by a
 *   request that is needed right now, it stops TV at once;
 * - a missing/rejected access token stops TV at once (retrying cannot help);
 * - [TV_MAX_FAILURES] failures in a row stop TV; the streak only ends once a video really played ([onProgressed]).
 */
class TvSession(private val maxFailures: Int = TV_MAX_FAILURES, private val keep: Int = TV_SEEN) {
    private val recent = ArrayDeque<String>()
    private var tickets = 0
    private var inFlight: Int? = null // ticket of the request whose answer still counts
    private var inFlightPrefetch = false
    private var held: TvPick? = null // fetched ahead of time, not started yet
    private var pendingStop: TvStep.Stop? = null // to be applied when the current video ends
    private var over = false

    /** Channel of the video last started: the next one must come from another channel. Empty before the first. */
    var after: String = ""
        private set

    var failures: Int = 0
        private set

    /** Oldest first, at most [keep]. */
    val seen: List<String> get() = recent.toList()

    /** Begin: ask for the first video. */
    fun onStart(): TvStep = fetch(prefetch = false)

    /** The current video finished playing. */
    fun onEnded(): TvStep = advance()

    /** The user pressed Skip. */
    fun onSkip(): TvStep = advance()

    /** The current video failed to play ([auth]: because the server rejected the token). */
    fun onPlaybackFailed(message: String?, auth: Boolean = false): TvStep {
        if (over) return TvStep.Wait
        if (auth) return stop(TvStep.Stop(message?.ifBlank { null }, needsToken = true))
        pendingStop?.let { return stop(it) }
        if (++failures >= maxFailures) return stop(TvStep.Stop(tvFailureMessage(message)))
        return advanceKeepingFailures()
    }

    /** The current video is within [TV_PREFETCH_SECONDS] of its end (called repeatedly; asks at most once). */
    fun onNearEnd(): TvStep = if (over || held != null || inFlight != null || pendingStop != null) TvStep.Wait else fetch(prefetch = true)

    /** The request for [ticket] returned [pick]. */
    fun onFetched(ticket: Int, pick: TvPick): TvStep {
        if (over || ticket != inFlight) return TvStep.Wait // stale: Skip, a failure or Stop moved on
        val early = inFlightPrefetch
        inFlight = null
        if (early) {
            held = pick
            return TvStep.Wait
        }
        return play(pick)
    }

    /** The request for [ticket] failed. */
    fun onFetchFailed(ticket: Int, failure: TvFailure): TvStep {
        if (over || ticket != inFlight) return TvStep.Wait
        val early = inFlightPrefetch
        inFlight = null
        return when (failure) {
            is TvFailure.Auth -> if (early) hold(TvStep.Stop(failure.message, needsToken = true)) else stop(TvStep.Stop(failure.message, needsToken = true))
            is TvFailure.NeedSubscriptions -> {
                val s = TvStep.Stop(tvNeedStopMessage(failure.message))
                if (early) hold(s) else stop(s)
            }
            is TvFailure.Other -> when {
                early -> TvStep.Wait // nothing is lost: the end of the video asks again
                ++failures >= maxFailures -> stop(TvStep.Stop(tvFailureMessage(failure.message)))
                else -> fetch(prefetch = false, delayMs = RETRY_MS)
            }
        }
    }

    /** A video has really played for [TV_CONFIRM_SECONDS]: the failure streak is over. */
    fun onProgressed() {
        failures = 0
    }

    /** The user stopped TV, the screen was left, the app was closed...: nothing may start after this. */
    fun onUserStop(message: String? = null): TvStep = stop(TvStep.Stop(message))

    /** The host handed [pick] to the player (also used for the first video). */
    private fun started(pick: TvPick) {
        recent.remove(pick.video.id)
        recent.addLast(pick.video.id)
        while (recent.size > keep) recent.removeFirst()
        after = pick.channelId
    }

    private fun advance(): TvStep {
        if (over) return TvStep.Wait
        pendingStop?.let { return stop(it) }
        return advanceKeepingFailures()
    }

    private fun advanceKeepingFailures(): TvStep {
        held?.let {
            held = null
            return play(it)
        }
        val running = inFlight
        if (running != null && inFlightPrefetch) {
            inFlightPrefetch = false // it is needed now: its answer plays the video
            return TvStep.Wait
        }
        return fetch(prefetch = false)
    }

    private fun play(pick: TvPick): TvStep {
        started(pick)
        return TvStep.Play(pick)
    }

    private fun fetch(prefetch: Boolean, delayMs: Long = 0): TvStep {
        val ticket = ++tickets
        inFlight = ticket
        inFlightPrefetch = prefetch
        return TvStep.Fetch(ticket, prefetch, delayMs)
    }

    private fun hold(s: TvStep.Stop): TvStep {
        pendingStop = s
        return TvStep.Wait
    }

    private fun stop(s: TvStep.Stop): TvStep {
        over = true
        inFlight = null
        held = null
        return s
    }

    private companion object {
        const val RETRY_MS = 1_000L
    }
}
