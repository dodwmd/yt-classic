package io.github.dodwmd.ytclassic.player

/** Playback keeps going after the app leaves the screen only if the user allows it and something is actually playing. */
fun continuesInBackground(keepSetting: Boolean, wantsToPlay: Boolean): Boolean = keepSetting && wantsToPlay

/**
 * Leaving the watch screen stops playback, unless the app is already in the background (stopped) and playback
 * [continuesInBackground]. With the app in the foreground, navigating away always stops.
 */
fun stopsOnLeavingScreen(appVisible: Boolean, keepSetting: Boolean, wantsToPlay: Boolean): Boolean =
    appVisible || !continuesInBackground(keepSetting, wantsToPlay)

/**
 * The service and notification end when the video finished, or when it failed with nobody looking at the Retry
 * button (app in the background). In the foreground an error keeps the session so Retry can resume it.
 */
fun endsSession(finished: Boolean, failed: Boolean, appVisible: Boolean): Boolean = finished || (failed && !appVisible)
