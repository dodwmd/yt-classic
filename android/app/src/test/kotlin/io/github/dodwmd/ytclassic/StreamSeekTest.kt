package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.player.StreamEnd
import io.github.dodwmd.ytclassic.player.StreamSeek
import kotlin.test.Test
import kotlin.test.assertEquals

/** A restart that is handed to the player at once. */
internal fun StreamSeek.restartAt(target: Long): Long = requestRestart(target).also { commitRestart() }

class StreamSeekTest {
    @Test
    fun positionIsOffsetByWhereTheStreamStarted() {
        val seek = StreamSeek(totalSeconds = 214)
        assertEquals(0, seek.position(0))
        assertEquals(12, seek.position(12_400))
        assertEquals(120, seek.restartAt(120))
        assertEquals(125, seek.position(5_000)) // 5s into the restarted stream = 2:05
    }

    @Test
    fun seeksAreClampedToTheVideo() {
        val seek = StreamSeek(totalSeconds = 214)
        assertEquals(213, seek.restartAt(9_999)) // never past the last second
        assertEquals(0, seek.restartAt(-5))
        assertEquals(214, StreamSeek(214, startSeconds = 100).position(999_000)) // position never exceeds the length
    }

    @Test
    fun streamThatStopsShortOfTheEndIsEndedEarly() {
        val seek = StreamSeek(totalSeconds = 214)
        assertEquals(true, seek.endedEarly(60_000)) // stopped at 1:00 of 3:34
        assertEquals(false, seek.endedEarly(212_000)) // within 5s of the end counts as finished
        seek.restartAt(200)
        assertEquals(false, seek.endedEarly(13_000)) // offset + 13s = 3:33
        assertEquals(false, StreamSeek(totalSeconds = 0).endedEarly(1_000)) // unknown length: can't tell
    }

    @Test
    fun startOffsetIsClamped() {
        assertEquals(213, StreamSeek(214, startSeconds = 5_000).base)
        assertEquals(0, StreamSeek(0, startSeconds = 30).base)
    }

    @Test
    fun staleEndWhileARestartIsPendingIsIgnored() {
        val seek = StreamSeek(totalSeconds = 214)
        seek.restartAt(100)
        assertEquals(StreamEnd.CutShort, seek.endOutcome(5_000)) // normal: 1:45 of 3:34
        seek.requestRestart(200) // seek requested, the old stream still reports
        assertEquals(StreamEnd.Stale, seek.endOutcome(5_000)) // its ENDED must not count against the new offset
        assertEquals(StreamEnd.Stale, seek.endOutcome(500_000))
        seek.commitRestart()
        assertEquals(StreamEnd.Finished, seek.endOutcome(13_000)) // 200 + 13 = 3:33, within tolerance
    }

    @Test
    fun baseOnlyMovesWhenTheNewStreamIsCommitted() {
        val seek = StreamSeek(totalSeconds = 214)
        seek.restartAt(50)
        assertEquals(150, seek.requestRestart(150))
        assertEquals(50, seek.base) // old stream still the one playing
        assertEquals(150_000, seek.positionMs(30_000)) // but the display already shows the target
        seek.failRestart() // e.g. streamUrl threw
        assertEquals(50, seek.base)
        assertEquals(80_000, seek.positionMs(30_000)) // old stream's position again, consistent with its base
        assertEquals(false, seek.restarting)
    }

    @Test
    fun laterRestartReplacesAnEarlierOne() {
        val seek = StreamSeek(totalSeconds = 214)
        seek.requestRestart(30)
        seek.requestRestart(90) // quick double seek
        seek.commitRestart()
        assertEquals(90, seek.base)
    }
}
