package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.Progress
import io.github.dodwmd.ytclassic.player.resumeStart
import io.github.dodwmd.ytclassic.player.shouldReport
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class ResumeRulesTest {
    @Test
    fun theLocalPositionWinsBecauseItIsNewerAndWorksOffline() {
        assertEquals(90L, resumeStart(local = 90, progress = Progress(position = 240)))
        assertEquals(90L, resumeStart(local = 90, progress = null))
    }

    @Test
    fun otherwiseTheServerPositionIsUsed() {
        assertEquals(240L, resumeStart(local = 0, progress = Progress(position = 240)))
    }

    @Test
    fun aFinishedOrUnknownVideoStartsAtTheBeginning() {
        assertEquals(0L, resumeStart(local = 0, progress = Progress(position = 214, completed = true)))
        assertEquals(0L, resumeStart(local = 0, progress = null))
    }

    @Test
    fun reportsOnlyWhenThePositionMovedExceptForTheFinalReport() {
        assertTrue(shouldReport(position = 10, lastReported = -1, finished = false))
        assertFalse(shouldReport(position = 10, lastReported = 10, finished = false))
        assertTrue(shouldReport(position = 10, lastReported = 10, finished = true))
    }
}
