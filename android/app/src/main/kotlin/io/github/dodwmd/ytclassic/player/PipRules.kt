package io.github.dodwmd.ytclassic.player

import kotlin.math.roundToInt

/** The widest and narrowest shapes Android accepts for a picture-in-picture window (2.39:1 down to 1:2.39). */
private const val MAX_RATIO_NUM = 239
private const val MAX_RATIO_DEN = 100

/** A picture-in-picture aspect ratio as a fraction (Android's `Rational`). */
data class PipRatio(val width: Int, val height: Int)

/**
 * The window shape for a video of [videoWidth] x [videoHeight] pixels ([pixelRatio] is the width of one pixel relative
 * to its height). Unknown sizes give 16:9; shapes outside what the platform allows are clamped to its limits.
 */
fun pipAspect(videoWidth: Int, videoHeight: Int, pixelRatio: Float = 1f): PipRatio {
    if (videoWidth <= 0 || videoHeight <= 0) return PipRatio(16, 9)
    val w = (videoWidth * (if (pixelRatio > 0f) pixelRatio else 1f)).roundToInt().coerceAtLeast(1)
    // Compare the rounded fraction, which is what Android validates.
    return when {
        w * MAX_RATIO_DEN >= MAX_RATIO_NUM * videoHeight -> PipRatio(MAX_RATIO_NUM, MAX_RATIO_DEN)
        w * MAX_RATIO_NUM <= MAX_RATIO_DEN * videoHeight -> PipRatio(MAX_RATIO_DEN, MAX_RATIO_NUM)
        else -> PipRatio(w, videoHeight)
    }
}

/** Whether the picture-in-picture button is offered: the device supports it, the setting is on, and there is a video. */
fun pipAvailable(supported: Boolean, setting: Boolean, hasVideo: Boolean): Boolean = supported && setting && hasVideo

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
