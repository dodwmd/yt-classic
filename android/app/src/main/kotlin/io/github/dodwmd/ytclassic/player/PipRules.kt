package io.github.dodwmd.ytclassic.player

import kotlin.math.roundToInt

/**
 * The widest and narrowest shapes used for the window: 2.38:1 down to 1:2.38. The platform allows 2.39 but compares
 * in floating point, so staying just inside it can never be rejected as invalid.
 */
private const val MAX_RATIO_NUM = 238L
private const val MAX_RATIO_DEN = 100L

/** A picture-in-picture aspect ratio as a fraction (Android's `Rational`). */
data class PipRatio(val width: Int, val height: Int)

/**
 * The window shape for a video of [videoWidth] x [videoHeight] pixels ([pixelRatio] is the width of one pixel relative
 * to its height; zero, negative and NaN count as 1). Unknown sizes give 16:9; shapes outside the limits are clamped.
 */
fun pipAspect(videoWidth: Int, videoHeight: Int, pixelRatio: Float = 1f): PipRatio {
    if (videoWidth <= 0 || videoHeight <= 0) return PipRatio(16, 9)
    val ratio = if (pixelRatio > 0f && pixelRatio.isFinite()) pixelRatio.toDouble() else 1.0
    val w = (videoWidth * ratio).toLong().coerceIn(1L, MAX_WIDTH)
    val h = videoHeight.toLong()
    // Compare the rounded fraction in Long arithmetic, which is what Android validates (no overflow: w <= 2^24).
    return when {
        w * MAX_RATIO_DEN >= MAX_RATIO_NUM * h -> PipRatio(MAX_RATIO_NUM.toInt(), MAX_RATIO_DEN.toInt())
        w * MAX_RATIO_NUM <= MAX_RATIO_DEN * h -> PipRatio(MAX_RATIO_DEN.toInt(), MAX_RATIO_NUM.toInt())
        else -> PipRatio(w.toInt(), h.toInt())
    }
}

private const val MAX_WIDTH = 1L shl 24

/** A rectangle in whole pixels. */
data class PipRect(val left: Int, val top: Int, val right: Int, val bottom: Int)

/**
 * Where the picture is inside a view of [width] x [height] at ([left], [top]) when it is fitted (letterboxed) at the
 * video's [ratio]: the transition should start from the picture, not from the black bars around it.
 */
fun fittedRect(left: Int, top: Int, width: Int, height: Int, ratio: PipRatio): PipRect {
    if (width <= 0 || height <= 0) return PipRect(left, top, left + width.coerceAtLeast(0), top + height.coerceAtLeast(0))
    val r = ratio.width.toDouble() / ratio.height
    val fitW: Int
    val fitH: Int
    if (width.toDouble() / height > r) { fitH = height; fitW = (height * r).toInt().coerceIn(1, width) }
    else { fitW = width; fitH = (width / r).toInt().coerceIn(1, height) }
    val x = left + (width - fitW) / 2
    val y = top + (height - fitH) / 2
    return PipRect(x, y, x + fitW, y + fitH)
}

/** Whether the picture-in-picture button and setting apply: the device allows it for this app, and the setting is on. */
fun pipAvailable(supported: Boolean, setting: Boolean): Boolean = supported && setting

/**
 * The activity was stopped while shown in the window: dismissed with X (the screen is on, nothing finishes the
 * activity). A screen that turned off, or the activity finishing, is not a dismissal.
 */
fun dismissedFromPip(inPip: Boolean, screenOn: Boolean, finishing: Boolean): Boolean = inPip && screenOn && !finishing

/**
 * Whether leaving the app (Home, recents) should shrink the player into a window. Only a video that is meant to be
 * playing right now qualifies: paused, finished, failed or nothing at all stays an ordinary background (where the
 * "Keep playing in the background" rules decide). Fullscreen does not matter: it is left while the window is shown.
 */
fun shouldEnterPip(wantsToPlay: Boolean, setting: Boolean, supported: Boolean): Boolean = wantsToPlay && setting && supported

/** The buttons in the picture-in-picture window. */
enum class PipAction { Play, Pause, Skip }

/** Play or Pause for the current state, and Skip while TV runs. Nothing when no video is loaded. */
fun pipActions(hasVideo: Boolean, wantsToPlay: Boolean, tv: Boolean): List<PipAction> = when {
    !hasVideo -> emptyList()
    else -> listOfNotNull(if (wantsToPlay) PipAction.Pause else PipAction.Play, if (tv) PipAction.Skip else null)
}
