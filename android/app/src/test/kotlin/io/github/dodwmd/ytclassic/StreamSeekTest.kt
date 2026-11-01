package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.player.StreamSeek
import kotlin.test.Test
import kotlin.test.assertEquals

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
}
