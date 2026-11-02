package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.ChannelSearchPage
import io.github.dodwmd.ytclassic.data.DurationFilter
import io.github.dodwmd.ytclassic.data.SearchHolder
import io.github.dodwmd.ytclassic.data.SearchPage
import io.github.dodwmd.ytclassic.data.SortFilter
import io.github.dodwmd.ytclassic.data.Suggester
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

/**
 * The Suggester runs on an unconfined scope with a controllable "clock": each wait is a deferred the test completes, so
 * nothing here sleeps or depends on real time.
 */
class SearchTest {
    private class Clock {
        val waits = mutableListOf<CompletableDeferred<Unit>>()
        suspend fun sleep(@Suppress("UNUSED_PARAMETER") ms: Long) {
            val d = CompletableDeferred<Unit>()
            waits += d
            d.await()
        }
        fun fire(i: Int) = waits[i].complete(Unit)
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    @Test
    fun filterParametersMatchTheServersValues() {
        assertEquals(listOf("any", "short", "medium", "long"), DurationFilter.entries.map { it.param })
        assertEquals(listOf("relevance", "date", "views"), SortFilter.entries.map { it.param })
    }

    @Test
    fun quickKeystrokesMakeOneRequestForTheLastText() {
        val clock = Clock()
        val asked = mutableListOf<String>()
        val got = mutableListOf<Pair<String, List<String>>>()
        val s = Suggester(scope, { asked += it; listOf("$it 1", "$it 2") }, { q, l -> got += q to l }, sleep = clock::sleep)
        s.input("c"); s.input("ca"); s.input("cat ")
        assertEquals(3, clock.waits.size)
        clock.fire(0); clock.fire(1) // the first two were cancelled: completing them does nothing
        assertTrue(asked.isEmpty())
        clock.fire(2)
        assertEquals(listOf("cat"), asked)
        assertEquals(listOf("cat" to listOf("cat 1", "cat 2")), got)
        scope.cancel()
    }

    @Test
    fun aNewKeystrokeCancelsTheRequestInFlightAndItsAnswerIsNeverReported() {
        val clock = Clock()
        val got = mutableListOf<Pair<String, List<String>>>()
        val cancelled = AtomicBoolean(false)
        val started = CompletableDeferred<Unit>()
        val s = Suggester(scope, { q ->
            if (q == "dog") {
                try {
                    started.complete(Unit)
                    CompletableDeferred<Unit>().await() // a server that never answers
                    listOf("stale")
                } catch (e: CancellationException) {
                    cancelled.set(true)
                    throw e
                }
            } else listOf("fresh")
        }, { q, l -> got += q to l }, sleep = clock::sleep)
        s.input("dog")
        clock.fire(0)
        assertTrue(started.isCompleted)
        s.input("dogs")
        assertTrue(cancelled.get(), "the in-flight request was cancelled")
        clock.fire(1)
        assertEquals(listOf("dogs" to listOf("fresh")), got)
        scope.cancel()
    }

    @Test
    fun blankTextCancelsAndAsksNothing() {
        val clock = Clock()
        val asked = mutableListOf<String>()
        val s = Suggester(scope, { asked += it; emptyList() }, { _, _ -> }, sleep = clock::sleep)
        s.input("abc")
        s.input("   ")
        clock.fire(0)
        assertEquals(1, clock.waits.size, "blank text starts nothing")
        assertTrue(asked.isEmpty())
        scope.cancel()
    }

    @Test
    fun aFailureReportsNoSuggestionsForThatTextAndAtMostEightOtherwise() {
        val clock = Clock()
        val got = mutableListOf<Pair<String, List<String>>>()
        val s = Suggester(scope, { if (it == "bad") throw ApiException("down") else List(20) { i -> "s$i" } }, { q, l -> got += q to l }, sleep = clock::sleep)
        s.input("bad")
        clock.fire(0)
        assertEquals(listOf("bad" to emptyList<String>()), got, "the failure is reported (so old suggestions are not shown for it), and nothing crashes")
        s.input("good")
        clock.fire(1)
        assertEquals(8, got.last().second.size)
        assertEquals("good", got.last().first)
        scope.cancel()
    }

    @Test
    fun theHolderKeepsPagesAndScrollStateForTheLatestKeysOnly() {
        val h = SearchHolder(max = 2)
        val a = SearchPage(nextPageToken = "2")
        h.putVideos(h.videoKey("x", DurationFilter.Any, SortFilter.Relevance), a)
        assertSame(a, h.videos(h.videoKey("x", DurationFilter.Any, SortFilter.Relevance)))
        assertNull(h.videos(h.videoKey("x", DurationFilter.Short, SortFilter.Relevance)), "another filter is another entry")
        h.putVideos("k2", SearchPage())
        h.videos(h.videoKey("x", DurationFilter.Any, SortFilter.Relevance)) // touched: now the most recent
        h.putVideos("k3", SearchPage()) // evicts k2
        assertNull(h.videos("k2"))
        assertSame(a, h.videos(h.videoKey("x", DurationFilter.Any, SortFilter.Relevance)))
        val c = ChannelSearchPage(nextPageToken = "3")
        h.putChannels("x", c)
        assertSame(c, h.channels("x"))
        var made = 0
        val s1 = h.state("v|x") { made++; StringBuilder("state") }
        assertSame(s1, h.state("v|x") { made++; StringBuilder("other") })
        assertEquals(1, made)
    }

    @Test
    fun yourOwnSubscribeChoiceIsRememberedForTheSession() {
        val h = SearchHolder()
        assertNull(h.subscribed("UC1"))
        h.setSubscribed("UC1", true)
        assertEquals(true, h.subscribed("UC1"))
        h.setSubscribed("UC1", false)
        assertEquals(false, h.subscribed("UC1"))
    }
}
