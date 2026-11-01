package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.MembershipTracker
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class MembershipTrackerTest {
    private fun ids(n: Int) = (0 until n).map { "v" + it.toString().padStart(10, '0') }

    @Test
    fun asksInChunksOfAHundredAndOnlyOnce() = runBlocking {
        val asked = mutableListOf<List<String>>()
        val t = MembershipTracker { chunk -> asked += chunk; chunk.filter { it.endsWith('7') }.toSet() }
        t.load(ids(250))
        assertEquals(listOf(100, 100, 50), asked.map { it.size })
        assertEquals(25, t.members.size)
        t.load(ids(260)) // only the 10 new ones
        assertEquals(listOf(100, 100, 50, 10), asked.map { it.size })
        t.load(ids(260) + ids(5)) // duplicates and known ids are not asked again
        assertEquals(4, asked.size)
        assertTrue(t.known(ids(1)[0]))
        assertFalse(t.known("zzzzzzzzzzz"))
    }

    @Test
    fun aFailedChunkIsRetriedAndEarlierChunksAreKept() = runBlocking {
        var calls = 0
        var failAt = 2
        val t = MembershipTracker { chunk ->
            if (++calls == failAt) throw ApiException("down")
            chunk.take(1).toSet()
        }
        assertFailsWith<ApiException> { t.load(ids(250)) }
        assertEquals(1, t.members.size, "the first chunk's answer is kept")
        assertTrue(t.known(ids(1)[0]))
        assertFalse(t.known(ids(150)[149]), "the failed chunk has no definite state")
        failAt = -1
        calls = 0
        t.load(ids(250))
        assertEquals(2, calls, "only the unasked chunks are asked again")
        assertEquals(3, t.members.size)
    }

    @Test
    fun aLateReplyNeverOverwritesWhatTheUserDidMeanwhile() = runBlocking {
        lateinit var t: MembershipTracker
        val a = ids(1)[0]
        val b = ids(2)[1]
        t = MembershipTracker { chunk ->
            t.set(a, true) // the user adds a while the request is in flight; the server (stale) says it is not there
            chunk.filter { it == b }.toSet()
        }
        t.load(listOf(a, b))
        assertEquals(setOf(a, b), t.members)
    }

    @Test
    fun aToggleBeforeTheRequestDoesNotBlockLaterAnswers() = runBlocking {
        val a = ids(1)[0]
        val t = MembershipTracker { setOf(a) }
        t.set(a, false)
        t.load(listOf(a)) // asked after the toggle: the server's answer is current
        assertEquals(setOf(a), t.members)
    }
}
