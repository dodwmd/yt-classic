package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.player.TV_MAX_FAILURES
import io.github.dodwmd.ytclassic.player.TV_SEEN
import io.github.dodwmd.ytclassic.player.TvSession
import io.github.dodwmd.ytclassic.player.tvFailureMessage
import io.github.dodwmd.ytclassic.player.tvNeedMessage
import io.github.dodwmd.ytclassic.player.tvNeedStopMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TvSessionTest {
    @Test
    fun theDisabledMessageCountsTheMissingSubscriptions() {
        assertEquals("Subscribe to 5 more channels to turn on TV", tvNeedMessage(0))
        assertEquals("Subscribe to 2 more channels to turn on TV", tvNeedMessage(3))
        assertEquals("Subscribe to 1 more channel to turn on TV", tvNeedMessage(4))
        assertNull(tvNeedMessage(5))
        assertNull(tvNeedMessage(120))
    }

    @Test
    fun aFreshSessionHasNoChannelAndNothingSeen() {
        val s = TvSession()
        assertEquals("", s.after)
        assertTrue(s.seen.isEmpty())
        assertEquals(0, s.failures)
    }

    @Test
    fun startedRemembersTheChannelAndTheVideoOldestFirst() {
        val s = TvSession()
        s.started("v1", "c1")
        s.started("v2", "c2")
        assertEquals("c2", s.after)
        assertEquals(listOf("v1", "v2"), s.seen)
        s.started("v1", "c3") // seen again: moves to the newest end, no duplicate
        assertEquals(listOf("v2", "v1"), s.seen)
    }

    @Test
    fun theSeenRingKeepsTheLastFiftyOnly() {
        val s = TvSession()
        repeat(TV_SEEN + 20) { s.started("v$it", "c") }
        assertEquals(TV_SEEN, s.seen.size)
        assertEquals("v20", s.seen.first())
        assertEquals("v${TV_SEEN + 19}", s.seen.last())
    }

    @Test
    fun stopsOnTheThirdConsecutiveFailure() {
        val s = TvSession()
        assertFalse(s.failed())
        assertFalse(s.failed())
        assertTrue(s.failed())
        assertEquals(TV_MAX_FAILURES, s.failures)
    }

    @Test
    fun aVideoThatReallyPlaysResetsTheFailureCount() {
        val s = TvSession()
        s.failed(); s.failed()
        s.playing()
        assertEquals(0, s.failures)
        assertFalse(s.failed())
        assertFalse(s.failed())
        assertTrue(s.failed())
    }

    @Test
    fun failuresThatAreNotConsecutiveNeverStopIt() {
        val s = TvSession()
        repeat(20) {
            assertFalse(s.failed())
            s.playing()
        }
    }

    @Test
    fun stopMessagesSayWhy() {
        assertEquals("TV stopped after 3 failures in a row: Couldn't play this video (ERROR_CODE_IO).", tvFailureMessage("Couldn't play this video (ERROR_CODE_IO)."))
        assertEquals("TV stopped after 3 failures in a row", tvFailureMessage(null))
        assertEquals("TV stopped. Subscribe to 1 more channel to turn on TV.", tvNeedStopMessage("Subscribe to 1 more channel to turn on TV."))
    }
}
