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

    /** True when the stream ended well before the real end, so it was cut short (e.g. the remux died) rather than finished. */
    fun endedEarly(playerPositionMs: Long, toleranceSeconds: Long = 5): Boolean =
        totalSeconds > 0 && position(playerPositionMs) < totalSeconds - toleranceSeconds

    /** Returns the offset to restart the stream at for a seek to [targetSeconds], and remembers it. */
    fun restartAt(targetSeconds: Long): Long {
        base = targetSeconds.coerceIn(0, maxOf(0, totalSeconds - 1))
        return base
    }
}
