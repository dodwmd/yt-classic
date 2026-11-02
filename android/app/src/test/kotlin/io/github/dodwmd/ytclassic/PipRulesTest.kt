package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.player.PipAction
import io.github.dodwmd.ytclassic.player.PipRatio
import io.github.dodwmd.ytclassic.player.PipRect
import io.github.dodwmd.ytclassic.player.dismissedFromPip
import io.github.dodwmd.ytclassic.player.fittedRect
import io.github.dodwmd.ytclassic.player.pipActions
import io.github.dodwmd.ytclassic.player.pipAspect
import io.github.dodwmd.ytclassic.player.pipAvailable
import io.github.dodwmd.ytclassic.player.shouldEnterPip
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PipRulesTest {
    private fun inside(r: PipRatio) = r.width * 1000L <= 2390L * r.height && r.height * 1000L <= 2390L * r.width

    /** wantsToPlay is the observable intent: false while paused (also while buffering or restarting), failed, finished or idle. */
    @Test fun `entering needs a video that is meant to play, the setting and device support`() {
        val table = listOf(
            // wantsToPlay, setting, supported -> enters
            Triple(true, true, true) to true,
            Triple(false, true, true) to false, // paused, also paused during buffering or a seek restart
            Triple(true, false, true) to false, // setting off
            Triple(true, true, false) to false, // no device support or not allowed for the app
            Triple(false, false, false) to false,
        )
        for ((input, expected) in table) {
            assertEquals(expected, shouldEnterPip(input.first, input.second, input.third), "$input")
        }
    }

    @Test fun `the button and setting need device permission and the setting`() {
        assertTrue(pipAvailable(supported = true, setting = true))
        assertFalse(pipAvailable(supported = false, setting = true))
        assertFalse(pipAvailable(supported = true, setting = false))
    }

    @Test fun `unknown size is 16 to 9`() {
        assertEquals(PipRatio(16, 9), pipAspect(0, 0))
        assertEquals(PipRatio(16, 9), pipAspect(1920, 0))
        assertEquals(PipRatio(16, 9), pipAspect(-1, 1080))
    }

    @Test fun `normal sizes keep their shape`() {
        assertEquals(PipRatio(1920, 1080), pipAspect(1920, 1080))
        assertEquals(PipRatio(1080, 1920), pipAspect(1080, 1920))
        assertEquals(PipRatio(1000, 1000), pipAspect(1000, 1000))
    }

    @Test fun `the pixel aspect ratio widens the shape and bad ratios count as 1`() {
        assertEquals(PipRatio(1440, 1080), pipAspect(1080, 1080, 4f / 3f))
        for (bad in listOf(0f, -1f, Float.NaN, Float.POSITIVE_INFINITY)) assertEquals(PipRatio(1920, 1080), pipAspect(1920, 1080, bad), "$bad")
    }

    @Test fun `extreme shapes and the exact platform limits stay inside 2_39 to 1`() {
        assertEquals(PipRatio(238, 100), pipAspect(3000, 1000))
        assertEquals(PipRatio(100, 238), pipAspect(500, 2000))
        // The platform's own limits (239:100 and 100:239) are clamped just inside, so a float compare cannot reject them.
        assertEquals(PipRatio(238, 100), pipAspect(239, 100))
        assertEquals(PipRatio(100, 238), pipAspect(100, 239))
        assertEquals(PipRatio(238, 100), pipAspect(2389, 1000)) // 2.389 is allowed by the platform but clamped here
    }

    @Test fun `every result is within the allowed range, also for huge and tiny sizes`() {
        val sizes = listOf(1 to 1, 24 to 10, 2389 to 1000, 7680 to 4320, Int.MAX_VALUE to 1, 1 to Int.MAX_VALUE, Int.MAX_VALUE to Int.MAX_VALUE, 100 to 239)
        for ((w, h) in sizes) for (pr in listOf(1f, 0.5f, 4f / 3f, 1000f)) assertTrue(inside(pipAspect(w, h, pr)), "$w x $h @ $pr")
    }

    @Test fun `actions follow the playback state and TV`() {
        val table = listOf(
            Triple(true, true, false) to listOf(PipAction.Pause),
            Triple(true, false, false) to listOf(PipAction.Play), // paused, buffering while paused, failed or finished
            Triple(true, true, true) to listOf(PipAction.Pause, PipAction.Skip),
            Triple(true, false, true) to listOf(PipAction.Play, PipAction.Skip),
            Triple(false, false, true) to emptyList(), // no video
            Triple(false, true, false) to emptyList(),
        )
        for ((input, expected) in table) assertEquals(expected, pipActions(input.first, input.second, input.third), "$input")
    }

    @Test fun `closing the window is a dismissal, a screen that turned off or a finishing activity is not`() {
        assertTrue(dismissedFromPip(inPip = true, screenOn = true, finishing = false))
        assertFalse(dismissedFromPip(inPip = true, screenOn = false, finishing = false))
        assertFalse(dismissedFromPip(inPip = true, screenOn = true, finishing = true))
        assertFalse(dismissedFromPip(inPip = false, screenOn = true, finishing = false)) // an ordinary Home press
    }

    @Test fun `the source rectangle is the picture, not the black bars`() {
        // A 16:9 picture in a square box: bars above and below.
        assertEquals(PipRect(0, 219, 1000, 781), fittedRect(0, 0, 1000, 1000, PipRatio(16, 9)))
        // Portrait video in a wide box: bars left and right, offset by the box's position.
        assertEquals(PipRect(100 + 339, 50, 100 + 339 + 281, 50 + 500), fittedRect(100, 50, 960, 500, PipRatio(9, 16)))
        // Same shape: the whole box.
        assertEquals(PipRect(0, 0, 1600, 900), fittedRect(0, 0, 1600, 900, PipRatio(16, 9)))
        assertEquals(PipRect(5, 5, 5, 5), fittedRect(5, 5, 0, 0, PipRatio(16, 9)))
    }
}
