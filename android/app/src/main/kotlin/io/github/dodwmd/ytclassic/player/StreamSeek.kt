package io.github.dodwmd.ytclassic.player

/**
 * The backend's stream is a live remux with no fixed length or byte layout, so the player can't seek in it.
 * Instead the app knows the real duration (from the API) and *restarts* the stream at `?t=<seconds>`.
 * This class tracks the offset the current stream started at, so absolute positions stay right.
 * (The web frontend's player.js does the same.)
 */
class StreamSeek(val totalSeconds: Long, startSeconds: Long = 0) {
    /** Where the current stream begins, in seconds from the start of the video. */
    var base: Long = startSeconds.coerceIn(0, maxOf(0, totalSeconds - 1))
        private set

    /** Absolute position for the player's current position within the stream. */
    fun position(playerPositionMs: Long): Long =
        (base + playerPositionMs / 1000).coerceAtMost(maxOf(0, totalSeconds))

    /** Set while a restart is pending: the target offset, not yet playing. */
    var pending: Long? = null
        private set

    /** True while a restart is pending, i.e. the player's own position and events still belong to the old stream. */
    val restarting: Boolean get() = pending != null

    /**
     * Absolute position in milliseconds. While a restart is pending the player still reports the old stream, so the
     * target offset is shown instead.
     */
    fun positionMs(playerPositionMs: Long): Long {
        val ms = pending?.times(1000) ?: (base * 1000 + playerPositionMs)
        return if (totalSeconds > 0) ms.coerceAtMost(totalSeconds * 1000) else ms
    }

    /** The real duration in milliseconds, or [unknown] when the API gave none. */
    fun durationMs(unknown: Long): Long = if (totalSeconds > 0) totalSeconds * 1000 else unknown

    /** True when the stream ended well before the real end, so it was cut short (e.g. the remux died) rather than finished. */
    fun endedEarly(playerPositionMs: Long, toleranceSeconds: Long = 5): Boolean =
        totalSeconds > 0 && position(playerPositionMs) < totalSeconds - toleranceSeconds

    /** What the player reaching its end means: nothing while a restart is pending (it is the old stream), else finished or cut short. */
    fun endOutcome(playerPositionMs: Long): StreamEnd = when {
        restarting -> StreamEnd.Stale
        endedEarly(playerPositionMs) -> StreamEnd.CutShort
        else -> StreamEnd.Finished
    }

    /** Starts a restart at [targetSeconds] (clamped) and returns the offset; [base] only moves on [commitRestart]. */
    fun requestRestart(targetSeconds: Long): Long {
        val start = targetSeconds.coerceIn(0, maxOf(0, totalSeconds - 1))
        pending = start
        return start
    }

    /** The new stream is being handed to the player: its offset becomes the base. */
    fun commitRestart() {
        pending?.let { base = it }
        pending = null
    }

    /** The restart couldn't start: keep the old base. */
    fun failRestart() {
        pending = null
    }
}

enum class StreamEnd { Stale, CutShort, Finished }
