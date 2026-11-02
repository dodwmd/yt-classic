package io.github.dodwmd.ytclassic.player

import android.graphics.Rect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/**
 * What the UI needs to know about picture-in-picture. MainActivity owns the window mode and updates this; the player
 * UI reads [inPip] (to drop all chrome), [available] (to offer the button), and reports where the video is on screen
 * through [videoBounds] (the transition's source rectangle).
 */
class PipState {
    /** The activity is currently shown in the small window. */
    var inPip by mutableStateOf(false)
    /** The button is offered: the device supports it and the setting is on. */
    var available by mutableStateOf(false)
    var videoBounds: Rect? = null
        private set
    /** Called when [videoBounds] changed, so the window parameters can be refreshed. Set by MainActivity. */
    var onBoundsChanged: () -> Unit = {}
    /** Shrinks the player into the window (the button). Set by MainActivity. */
    var enter: () -> Unit = {}

    fun setVideoBounds(bounds: Rect) {
        if (inPip || bounds == videoBounds) return // inside the window the bounds describe the window, not the screen
        videoBounds = Rect(bounds)
        onBoundsChanged()
    }
}

val LocalPip = compositionLocalOf { PipState() }
