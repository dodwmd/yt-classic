package io.github.dodwmd.ytclassic

import androidx.media3.common.Player
import io.github.dodwmd.ytclassic.player.StreamSeek
import io.github.dodwmd.ytclassic.player.allowedControllerCommandIds
import io.github.dodwmd.ytclassic.player.canStartPlayback
import io.github.dodwmd.ytclassic.player.endsSessionOnAppStop
import io.github.dodwmd.ytclassic.player.continuesInBackground
import io.github.dodwmd.ytclassic.player.endsSession
import io.github.dodwmd.ytclassic.player.stopsOnLeavingScreen
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PlaybackRulesTest {
    @Test
    fun backgroundNeedsTheSettingAndActivePlayback() {
        assertTrue(continuesInBackground(keepSetting = true, wantsToPlay = true))
        assertFalse(continuesInBackground(keepSetting = false, wantsToPlay = true)) // setting off: old pause-on-stop
        assertFalse(continuesInBackground(keepSetting = true, wantsToPlay = false)) // paused stays paused
    }

    @Test
    fun navigatingAwayInTheForegroundAlwaysStops() {
        assertTrue(stopsOnLeavingScreen(appVisible = true, keepSetting = true, wantsToPlay = true))
        assertFalse(stopsOnLeavingScreen(appVisible = false, keepSetting = true, wantsToPlay = true)) // playing on in the background
        assertTrue(stopsOnLeavingScreen(appVisible = false, keepSetting = false, wantsToPlay = true))
        assertTrue(stopsOnLeavingScreen(appVisible = false, keepSetting = true, wantsToPlay = false))
    }

    @Test
    fun sessionEndsWhenFinishedOrFailedOutOfSight() {
        assertTrue(endsSession(finished = true, failed = false, appVisible = true))
        assertTrue(endsSession(finished = false, failed = true, appVisible = false)) // nobody can press Retry
        assertFalse(endsSession(finished = false, failed = true, appVisible = true)) // Retry is on screen
        assertFalse(endsSession(finished = false, failed = false, appVisible = false))
    }

    @Test
    fun absolutePositionAndDurationForTheSession() {
        val seek = StreamSeek(totalSeconds = 214)
        assertEquals(214_000, seek.durationMs(unknown = -1))
        assertEquals(-1, StreamSeek(0).durationMs(unknown = -1))
        seek.restartAt(120)
        assertEquals(125_500, seek.positionMs(5_500)) // 5.5s into a stream that started at 2:00
        seek.requestRestart(120)
        assertEquals(120_000, seek.positionMs(5_500))
        seek.commitRestart() // old stream's position is ignored until the new one is set
        assertEquals(214_000, seek.positionMs(999_000)) // never past the end
        assertEquals(7_000, StreamSeek(0).positionMs(7_000)) // unknown length: not clamped
    }

    @Test
    fun hiddenAppWithBackgroundAudioOffCannotStartPlayback() {
        assertTrue(canStartPlayback(appVisible = true, keepSetting = false))
        assertTrue(canStartPlayback(appVisible = false, keepSetting = true))
        assertFalse(canStartPlayback(appVisible = false, keepSetting = false)) // stray headset/notification Play
        assertTrue(endsSessionOnAppStop(keepSetting = false))
        assertFalse(endsSessionOnAppStop(keepSetting = true))
    }

    @Test
    fun controllersMayPlaySeekAndReadButNotChangeItems() {
        val c = allowedControllerCommandIds.toSet()
        for (ok in listOf(Player.COMMAND_PLAY_PAUSE, Player.COMMAND_STOP, Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM, Player.COMMAND_SEEK_BACK, Player.COMMAND_SEEK_FORWARD, Player.COMMAND_GET_CURRENT_MEDIA_ITEM, Player.COMMAND_GET_TIMELINE, Player.COMMAND_GET_METADATA)) assertTrue(c.contains(ok), "command $ok")
        for (no in listOf(Player.COMMAND_SET_MEDIA_ITEM, Player.COMMAND_CHANGE_MEDIA_ITEMS, Player.COMMAND_SET_REPEAT_MODE, Player.COMMAND_SET_SHUFFLE_MODE, Player.COMMAND_SET_SPEED_AND_PITCH, Player.COMMAND_PREPARE, Player.COMMAND_RELEASE)) assertFalse(c.contains(no), "command $no")
    }
}
