package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.player.TV_MAX_FAILURES
import io.github.dodwmd.ytclassic.player.TV_SEEN
import io.github.dodwmd.ytclassic.player.TvFailure
import io.github.dodwmd.ytclassic.player.TvPick
import io.github.dodwmd.ytclassic.player.TvSession
import io.github.dodwmd.ytclassic.player.TvStep
import io.github.dodwmd.ytclassic.player.tvFailureMessage
import io.github.dodwmd.ytclassic.player.tvNeedMessage
import io.github.dodwmd.ytclassic.player.tvNeedStopMessage
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue

class TvSessionTest {
    private fun pick(n: Int, channel: String = "c$n") = TvPick(VideoDetail(id = "v$n", title = "t$n", channelId = channel), channel, 720)
    private fun TvStep.fetch() = assertIs<TvStep.Fetch>(this)
    private fun TvStep.play() = assertIs<TvStep.Play>(this).pick
    private fun TvStep.stop() = assertIs<TvStep.Stop>(this)

    /** A session that already plays pick(1). */
    private fun playing(): TvSession {
        val s = TvSession()
        s.onFetched(s.onStart().fetch().ticket, pick(1)).play()
        return s
    }

    @Test
    fun theDisabledMessageCountsTheMissingSubscriptions() {
        assertEquals("Subscribe to 5 more channels to turn on TV", tvNeedMessage(0))
        assertEquals("Subscribe to 2 more channels to turn on TV", tvNeedMessage(3))
        assertEquals("Subscribe to 1 more channel to turn on TV", tvNeedMessage(4))
        assertNull(tvNeedMessage(5))
        assertNull(tvNeedMessage(120))
    }

    @Test
    fun startingAsksForTheFirstVideoAndPlaysIt() {
        val s = TvSession()
        assertEquals("", s.after)
        val f = s.onStart().fetch()
        assertFalse(f.prefetch)
        assertEquals(pick(1), s.onFetched(f.ticket, pick(1)).play())
        assertEquals("c1", s.after)
        assertEquals(listOf("v1"), s.seen)
    }

    @Test
    fun endingAsksForTheNextVideoFromTheLastChannel() {
        val s = playing()
        val f = s.onEnded().fetch()
        assertEquals("c1", s.after, "the request carries the channel that just played")
        assertEquals("v2", s.onFetched(f.ticket, pick(2)).play().video.id)
        assertEquals(listOf("v1", "v2"), s.seen)
    }

    @Test
    fun theSeenRingKeepsTheLastFiftyOnlyAndDoesNotDuplicate() {
        val s = TvSession()
        var step = s.onStart()
        repeat(TV_SEEN + 20) {
            s.onFetched(step.fetch().ticket, pick(it))
            step = s.onEnded()
        }
        assertEquals(TV_SEEN, s.seen.size)
        assertEquals("v20", s.seen.first())
        assertEquals("v${TV_SEEN + 19}", s.seen.last())
    }

    @Test
    fun anAnswerToAnOldRequestIsIgnoredAfterSkipAndAfterStop() {
        val s = playing()
        val first = s.onSkip().fetch()
        val second = s.onSkip().fetch() // Skip pressed again before the first answer
        assertTrue(second.ticket != first.ticket)
        assertEquals(TvStep.Wait, s.onFetched(first.ticket, pick(2)), "the stale answer must not play")
        assertEquals(TvStep.Wait, s.onFetchFailed(first.ticket, TvFailure.Other("late")), "nor count as a failure")
        assertEquals(0, s.failures)
        assertEquals("v3", s.onFetched(second.ticket, pick(3)).play().video.id)

        val t = playing()
        val pending = t.onEnded().fetch()
        assertIs<TvStep.Stop>(t.onUserStop())
        assertEquals(TvStep.Wait, t.onFetched(pending.ticket, pick(2)), "nothing plays after Stop")
        assertEquals(TvStep.Wait, t.onEnded())
        assertEquals(TvStep.Wait, t.onSkip())
        assertEquals(TvStep.Wait, t.onNearEnd())
    }

    @Test
    fun threeFailuresInARowStopAndSuccessfulPlaybackResetsTheStreak() {
        val s = playing()
        assertIs<TvStep.Fetch>(s.onPlaybackFailed("x"))
        val f2 = s.onFetched(s.onSkip().fetch().ticket, pick(2)) // a new video was fetched fine...
        assertIs<TvStep.Play>(f2)
        assertEquals(1, s.failures, "fetching a video is not progress")
        assertIs<TvStep.Fetch>(s.onPlaybackFailed("y"))
        assertEquals(2, s.failures)
        s.onProgressed() // played for real
        assertEquals(0, s.failures)
        assertIs<TvStep.Fetch>(s.onPlaybackFailed("a"))
        assertIs<TvStep.Fetch>(s.onPlaybackFailed("b"))
        val stop = s.onPlaybackFailed("c").stop()
        assertEquals(tvFailureMessage("c"), stop.message)
        assertEquals(TV_MAX_FAILURES, 3)
    }

    @Test
    fun failedRequestsAreRetriedAfterADelayAndStopOnTheThird() {
        val s = TvSession()
        var f = s.onStart().fetch()
        val retry1 = s.onFetchFailed(f.ticket, TvFailure.Other("down")).fetch()
        assertTrue(retry1.delayMs > 0)
        val retry2 = s.onFetchFailed(retry1.ticket, TvFailure.Other("down")).fetch()
        val stop = s.onFetchFailed(retry2.ticket, TvFailure.Other("down")).stop()
        assertEquals(tvFailureMessage("down"), stop.message)
        assertFalse(stop.needsToken)
    }

    @Test
    fun theNextVideoIsRequestedEarlyOnceAndHeldUntilTheEnd() {
        val s = playing()
        val early = s.onNearEnd().fetch()
        assertTrue(early.prefetch)
        assertEquals(TvStep.Wait, s.onNearEnd(), "asked once")
        assertEquals(TvStep.Wait, s.onFetched(early.ticket, pick(2)), "held, not started")
        assertEquals(listOf("v1"), s.seen)
        assertEquals(TvStep.Wait, s.onNearEnd(), "and not asked again while held")
        assertEquals("v2", s.onEnded().play().video.id, "the end hands over at once, no request")
        assertEquals(listOf("v1", "v2"), s.seen)
    }

    @Test
    fun skipUsesTheHeldVideo() {
        val s = playing()
        s.onFetched(s.onNearEnd().fetch().ticket, pick(2))
        assertEquals("v2", s.onSkip().play().video.id)
    }

    @Test
    fun anEndWhileTheEarlyRequestIsStillRunningWaitsForItAndThenPlays() {
        val s = playing()
        val early = s.onNearEnd().fetch()
        assertEquals(TvStep.Wait, s.onEnded(), "no second request: the running one is needed now")
        assertEquals("v2", s.onFetched(early.ticket, pick(2)).play().video.id)
    }

    @Test
    fun anEarlyRequestThatFailsIsRetriedAtTheEnd() {
        val s = playing()
        val early = s.onNearEnd().fetch()
        assertEquals(TvStep.Wait, s.onFetchFailed(early.ticket, TvFailure.Other("blip")))
        assertEquals(0, s.failures, "a failed look-ahead costs nothing")
        s.onEnded().fetch()
    }

    @Test
    fun tooFewSubscriptionsFoundEarlyStopsOnlyAfterTheCurrentVideo() {
        val s = playing()
        val early = s.onNearEnd().fetch()
        assertEquals(TvStep.Wait, s.onFetchFailed(early.ticket, TvFailure.NeedSubscriptions("Subscribe to 1 more channel to turn on TV.")))
        assertEquals(TvStep.Wait, s.onNearEnd(), "the current video plays on and nothing more is asked")
        val stop = s.onEnded().stop()
        assertEquals(tvNeedStopMessage("Subscribe to 1 more channel to turn on TV."), stop.message)
        assertEquals(TvStep.Wait, s.onEnded())
    }

    @Test
    fun tooFewSubscriptionsFoundByARequestNeededNowStopsAtOnce() {
        val s = playing()
        val f = s.onEnded().fetch()
        assertEquals("TV stopped. Subscribe to 2 more channels to turn on TV.", s.onFetchFailed(f.ticket, TvFailure.NeedSubscriptions("Subscribe to 2 more channels to turn on TV.")).stop().message)
    }

    @Test
    fun skipWhileATooFewSubscriptionsStopIsPendingStops() {
        val s = playing()
        s.onFetchFailed(s.onNearEnd().fetch().ticket, TvFailure.NeedSubscriptions("Subscribe to 1 more channel to turn on TV."))
        s.onSkip().stop()
    }

    @Test
    fun aRejectedTokenStopsAtOnceWithTheSettingsAction() {
        val s = TvSession()
        val stop = s.onFetchFailed(s.onStart().fetch().ticket, TvFailure.Auth("Server needs an access token: set it in Settings.")).stop()
        assertTrue(stop.needsToken)
        val t = playing()
        assertTrue(t.onPlaybackFailed("401", auth = true).stop().needsToken)
        // Found by the look-ahead: the current video finishes first, then the same stop.
        val u = playing()
        assertEquals(TvStep.Wait, u.onFetchFailed(u.onNearEnd().fetch().ticket, TvFailure.Auth("rejected")))
        assertTrue(u.onEnded().stop().needsToken)
    }

    @Test
    fun aVideoThatFailsWhileAStopIsPendingStopsInstead() {
        val s = playing()
        s.onFetchFailed(s.onNearEnd().fetch().ticket, TvFailure.NeedSubscriptions("Subscribe to 1 more channel to turn on TV."))
        s.onPlaybackFailed("broken").stop()
    }

    @Test
    fun taskRemovalAndUserStopEndTheSessionForGood() {
        val s = playing()
        val stop = s.onUserStop("TV stopped because the app was closed.").stop()
        assertEquals("TV stopped because the app was closed.", stop.message)
        assertEquals(TvStep.Wait, s.onFetched(99, pick(2)))
        assertEquals(TvStep.Wait, s.onPlaybackFailed("x"))
    }
}
