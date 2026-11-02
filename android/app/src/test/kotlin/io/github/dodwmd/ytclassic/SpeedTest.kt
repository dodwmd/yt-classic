package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.player.PLAYBACK_SPEEDS
import io.github.dodwmd.ytclassic.player.StreamSeek
import io.github.dodwmd.ytclassic.player.TapSeekRun
import io.github.dodwmd.ytclassic.player.TapZone
import io.github.dodwmd.ytclassic.player.clampSpeed
import io.github.dodwmd.ytclassic.player.speedLabel
import io.github.dodwmd.ytclassic.player.tapZone
import io.github.dodwmd.ytclassic.player.wallSecondsLeft
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SpeedTest {
    @Test
    fun speedsAreTheWebList() {
        assertEquals(listOf(0.5f, 0.75f, 1f, 1.25f, 1.5f, 1.75f, 2f), PLAYBACK_SPEEDS)
    }

    @Test
    fun unknownSpeedsFallBackToNormal() {
        assertEquals(1.5f, clampSpeed(1.5f))
        for (bad in listOf(null, 0f, 0.1f, 3f, -1f, Float.NaN)) assertEquals(1f, clampSpeed(bad))
    }

    @Test
    fun labels() {
        assertEquals(listOf("0.5x", "0.75x", "1x", "1.25x", "1.5x", "1.75x", "2x"), PLAYBACK_SPEEDS.map(::speedLabel))
    }

    @Test
    fun streamPositionIsMediaTimeNotWallTime() {
        // ExoPlayer reports media time, so the absolute position math is the same at any speed.
        val seek = StreamSeek(totalSeconds = 600)
        seek.requestRestart(100); seek.commitRestart()
        assertEquals(130, seek.position(30_000)) // 30 s of media played, whether it took 15 s (2x) or 60 s (0.5x)
        assertEquals(130_000, seek.positionMs(30_000))
    }

    @Test
    fun timeLeftInRealTimeShrinksWithSpeed() {
        assertEquals(30.0, wallSecondsLeft(600, 570, 1f))
        assertEquals(15.0, wallSecondsLeft(600, 570, 2f))
        assertEquals(60.0, wallSecondsLeft(600, 570, 0.5f))
        assertEquals(0.0, wallSecondsLeft(600, 700, 1f))
    }

    @Test
    fun thirds() {
        assertEquals(TapZone.Back, tapZone(10f, 300f))
        assertEquals(TapZone.Middle, tapZone(150f, 300f))
        assertEquals(TapZone.Forward, tapZone(290f, 300f))
        assertEquals(TapZone.Middle, tapZone(5f, 0f))
    }

    @Test
    fun aRunKeepsAccumulatingUntilItIsFinished() {
        val run = TapSeekRun()
        assertEquals(10, run.add(TapZone.Forward, 100))
        assertEquals(20, run.add(TapZone.Forward, 999)) // position is only read when a run starts
        assertEquals(120, run.target)
        assertEquals(10, run.add(TapZone.Back, 999))
        assertEquals(110, run.target)
        assertTrue(run.active)
        for (i in 1..50) run.add(TapZone.Forward, 999) // however slow the user is, no tap is dropped: only finish() ends a run
        assertEquals(10 + 500L, run.delta)
        run.finish()
        assertFalse(run.active)
        assertEquals(-10, run.add(TapZone.Back, 50)) // the next tap starts a new run from the new position
        assertEquals(40, run.target)
    }

    @Test
    fun finishingDiscardsThePendingTarget() {
        // The slider or a TalkBack jump finishes the run, so the pending timer finds nothing to commit.
        val run = TapSeekRun()
        run.add(TapZone.Forward, 100)
        run.finish()
        assertFalse(run.active)
        assertEquals(0, run.delta)
    }

    @Test
    fun middleTapsNeverSeek() {
        val run = TapSeekRun()
        assertEquals(0, run.add(TapZone.Middle, 10))
        assertFalse(run.active)
    }
}
