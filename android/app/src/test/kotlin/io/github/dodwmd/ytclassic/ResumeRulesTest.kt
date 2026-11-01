package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.Progress
import io.github.dodwmd.ytclassic.player.StreamEnd
import io.github.dodwmd.ytclassic.player.StreamSeek
import io.github.dodwmd.ytclassic.player.reportsOnPause
import io.github.dodwmd.ytclassic.player.resumeStart
import io.github.dodwmd.ytclassic.player.shouldReport
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ResumeRulesTest {
    @Test
    fun theLocalPositionWinsBecauseItIsNewerAndWorksOffline() {
        assertEquals(90L, resumeStart(local = 90, progress = Progress(position = 240), durationSeconds = 600))
        assertEquals(90L, resumeStart(local = 90, progress = null, durationSeconds = 600))
    }

    @Test
    fun otherwiseTheServerPositionIsUsed() {
        assertEquals(240L, resumeStart(local = 0, progress = Progress(position = 240), durationSeconds = 600))
    }

    @Test
    fun aFinishedOrUnknownVideoStartsAtTheBeginning() {
        assertEquals(0L, resumeStart(local = 0, progress = Progress(position = 214, completed = true), durationSeconds = 214))
        assertEquals(0L, resumeStart(local = 0, progress = null, durationSeconds = 600))
    }

    @Test
    fun reportsOnlyWhenThePositionMovedExceptForTheFinalReport() {
        assertTrue(shouldReport(position = 10, lastReported = -1, finished = false))
        assertFalse(shouldReport(position = 10, lastReported = 10, finished = false))
        assertTrue(shouldReport(position = 10, lastReported = 10, finished = true))
    }

    @Test
    fun anUnknownLengthOrAPositionAtTheEndStartsOver() {
        assertEquals(0L, resumeStart(local = 0, progress = Progress(position = 240), durationSeconds = 0)) // cannot restart at an offset
        assertEquals(0L, resumeStart(local = 0, progress = Progress(position = 595), durationSeconds = 600)) // within 10 s of the end
        assertEquals(589L, resumeStart(local = 589, progress = null, durationSeconds = 600))
    }

    @Test
    fun onlyARealPauseIsReported() {
        assertTrue(reportsOnPause(isPlaying = false, playWhenReady = false, restarting = false))
        assertFalse(reportsOnPause(isPlaying = false, playWhenReady = true, restarting = false)) // rebuffering or focus loss
        assertFalse(reportsOnPause(isPlaying = false, playWhenReady = false, restarting = true)) // a seek is not a stop
        assertFalse(reportsOnPause(isPlaying = true, playWhenReady = true, restarting = false))
    }

    @Test
    fun streamsOfUnknownLengthIgnoreTheStartAndFinishCleanly() {
        val seek = StreamSeek(0, 90)
        assertEquals(0L, seek.base) // cannot be restarted at an offset
        assertEquals(StreamEnd.Finished, seek.endOutcome(5_000)) // no way to call it cut short
        assertEquals(0L, seek.positionMs(0))
    }
}
