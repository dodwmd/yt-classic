package io.github.dodwmd.ytclassic.player

/** Playback speeds offered in the player (the same list as the web player). */
val PLAYBACK_SPEEDS: List<Float> = listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f)

/** A stored or requested speed that isn't one of [PLAYBACK_SPEEDS] means normal speed. */
fun clampSpeed(speed: Float?): Float = speed?.takeIf { it in PLAYBACK_SPEEDS } ?: 1f

/** "1x", "1.25x", "0.5x". */
fun speedLabel(speed: Float): String = (if (speed % 1f == 0f) speed.toInt().toString() else speed.toString()) + "x"

/**
 * Seconds of real time until the end. Positions and durations are media time (what the player reports, unaffected
 * by speed); anything that waits in wall-clock time (TV asking for the next video shortly before the end) must divide by the speed.
 */
fun wallSecondsLeft(totalSeconds: Long, positionSeconds: Long, speed: Float): Double =
    (totalSeconds - positionSeconds).coerceAtLeast(0) / clampSpeed(speed).toDouble()

/** Double-tap seek distance, and how long consecutive double taps keep adding up before the stream is restarted. */
const val TAP_SEEK_SECONDS = 10L
const val TAP_ACCUMULATE_MS = 700L

/** Which part of the video a tap landed on: the left third rewinds, the right third forwards, the middle does nothing. */
enum class TapZone(val direction: Int) { Back(-1), Middle(0), Forward(1) }

fun tapZone(x: Float, width: Float): TapZone = when {
    width <= 0f -> TapZone.Middle
    x < width / 3f -> TapZone.Back
    x > width * 2f / 3f -> TapZone.Forward
    else -> TapZone.Middle
}

/**
 * YouTube-style accumulation: each double tap adds [TAP_SEEK_SECONDS] in its direction while a run is [active].
 * Only the owner's timer ends a run ([finish], [TAP_ACCUMULATE_MS] after the last tap, or when something else seeks):
 * there is no time comparison here, so a tap landing right at the boundary can't discard the taps before it. The
 * stream is only restarted (at [target]) once the run is over.
 */
class TapSeekRun {
    private var from = 0L

    /** Net seconds so far in this run (negative = back). */
    var delta = 0L
        private set

    /** True while a run has taps that haven't been committed. */
    var active = false
        private set

    /** Adds a double tap; [positionSeconds] is the current position (used only when a run starts). Returns the net seconds. */
    fun add(zone: TapZone, positionSeconds: Long): Long {
        if (zone == TapZone.Middle) return delta
        if (!active) {
            from = positionSeconds
            delta = 0
            active = true
        }
        delta += zone.direction * TAP_SEEK_SECONDS
        return delta
    }

    /** Where to seek, before the host clamps it to the video. */
    val target: Long get() = from + delta

    /** The run is over: its seek was issued, or another seek (slider, TalkBack action) replaced it. */
    fun finish() {
        active = false
        delta = 0
    }
}
