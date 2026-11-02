package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.apiErrorFrom
import io.github.dodwmd.ytclassic.data.errorActions
import io.github.dodwmd.ytclassic.data.isSkippable
import io.github.dodwmd.ytclassic.data.retryStreamStatus
import io.github.dodwmd.ytclassic.data.shortMessage
import io.github.dodwmd.ytclassic.data.showPlayer
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class ErrorsTest {
    private val skippable = listOf("age-restricted", "region-blocked", "private", "removed", "members-only", "live", "upcoming")

    @Test
    fun unplayableCodesAreSkippableAndOfferNoRetry() {
        for (c in skippable) {
            assertTrue(isSkippable(c), c)
            val a = errorActions(c)
            assertFalse(a.showRetry, "$c must not offer a useless Retry")
            assertNull(a.hint)
        }
    }

    @Test
    fun temporaryCodesOfferRetryWithAnExplanation() {
        for (c in listOf("rate-limited", "bot-check", "busy", "network")) {
            assertFalse(isSkippable(c), c)
            val a = errorActions(c)
            assertTrue(a.showRetry, c)
            assertNotNull(a.hint, c)
        }
    }

    @Test
    fun unknownOrMissingCodesKeepAPlainRetry() {
        for (c in listOf("unknown", null, "something-new")) {
            assertFalse(isSkippable(c))
            assertEquals(errorActions(c).showRetry to errorActions(c).hint, true to null)
        }
    }

    @Test
    fun streamErrorBodiesAreParsedIntoMessageAndCode() {
        val e = apiErrorFrom(403, """{"error":"This video is age-restricted and can't be played here.","code":"age-restricted","retryable":false}""")
        assertEquals("This video is age-restricted and can't be played here.", e.message)
        assertEquals("age-restricted", e.code)
        assertFalse(e.retryable)
        val busy = apiErrorFrom(503, """{"error":"The server is busy. Try again in a few seconds.","code":"busy","retryable":true}""")
        assertEquals("busy", busy.code)
        assertTrue(busy.retryable)
    }

    @Test
    fun bodiesThatAreNotTheErrorJsonFallBackToTheStatus() {
        for (body in listOf("", "could not stream video", "<html>502</html>", """{"error":""}""")) {
            val e = apiErrorFrom(502, body)
            assertEquals("Request failed (502)", e.message, body)
            assertNull(e.code)
        }
    }

    @Test
    fun theServersRetryableFlagDecidesForCodesThisAppDoesNotKnow() {
        assertFalse(errorActions("brand-new-code", retryable = false).showRetry)
        assertTrue(errorActions("brand-new-code", retryable = true).showRetry)
        assertTrue(errorActions("unknown", retryable = true).showRetry)
        assertTrue(errorActions(null, retryable = false).showRetry, "no code (an older server, offline) keeps Retry")
        assertFalse(errorActions("private", retryable = true).showRetry, "known skippable codes win over the flag")
    }

    @Test
    fun turnedOffCommentsAreNotASkippableVideoErrorAndNeverOfferRetry() {
        assertFalse(isSkippable("comments-disabled"), "the video still plays; only its comments are off")
        assertFalse(errorActions("comments-disabled", retryable = false).showRetry)
    }

    @Test
    fun aHintNeverHidesThePlayerForGood() {
        assertTrue(showPlayer(playable = true, reason = null, override = false))
        for (r in skippable) {
            assertFalse(showPlayer(false, r, override = false), r)
            assertTrue(showPlayer(false, r, override = true), "Try anyway for $r")
        }
        assertTrue(showPlayer(false, null, false), "a hint without a reason is not trusted")
    }

    @Test
    fun streamRetriesStopForAnswersThatRetryingCannotChange() {
        val classified = """{"error":"x","code":"rate-limited","retryable":true}"""
        assertFalse(retryStreamStatus(404, ""))
        assertFalse(retryStreamStatus(429, classified))
        assertFalse(retryStreamStatus(503, classified), "a classified 5xx says why: don't hit the server again")
        assertTrue(retryStreamStatus(502, "<html>bad gateway</html>"), "a bare proxy 5xx keeps the default retries")
        assertTrue(retryStreamStatus(503, """{"error":"x"}"""))
    }

    @Test
    fun bodiesWithoutACodeStillShowTheirText_andLongOnesAreCut() {
        val e = apiErrorFrom(500, """{"error":"Disk is full"}""")
        assertEquals("Disk is full", e.message)
        assertNull(e.code)
        val long = apiErrorFrom(502, """{"error":"${"x".repeat(5000)}","code":"unknown"}""")
        assertEquals(200, long.message!!.length)
        assertEquals(200, shortMessage("y".repeat(300)).length)
        assertEquals("short", shortMessage("short"))
    }
}
