package io.github.dodwmd.ytclassic.player

import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi

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

/** Audio may only start while the app is on screen, or when background audio is allowed (a stray headset/notification Play must not). */
fun canStartPlayback(appVisible: Boolean, keepSetting: Boolean): Boolean = appVisible || keepSetting

/** Whether the session/service must go away when the app is stopped: background audio is off. */
fun endsSessionOnAppStop(keepSetting: Boolean): Boolean = !keepSetting

/**
 * Only the system (notification, lock screen, media controls) and this app may control the session, and only
 * with these player commands: play/pause, stop, seeking and reading state. No changing items, repeat, shuffle or speed.
 */
val allowedControllerCommandIds: IntArray = intArrayOf(
    Player.COMMAND_PLAY_PAUSE, Player.COMMAND_STOP,
    Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD,
    Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA,
    Player.COMMAND_GET_AUDIO_ATTRIBUTES,
)

@OptIn(UnstableApi::class)
fun allowedControllerCommands(): Player.Commands =
    Player.Commands.Builder().apply { allowedControllerCommandIds.forEach { add(it) } }.build()
