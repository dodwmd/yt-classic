package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.player.PipAction
import io.github.dodwmd.ytclassic.player.PipRatio
import io.github.dodwmd.ytclassic.player.pipActions
import io.github.dodwmd.ytclassic.player.pipAspect
import io.github.dodwmd.ytclassic.player.pipAvailable
import io.github.dodwmd.ytclassic.player.shouldEnterPip
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class PipRulesTest {
    @Test fun `a video that is playing enters the window when the setting is on and the device supports it`() {
        assertTrue(shouldEnterPip(wantsToPlay = true, setting = true, supported = true))
    }

    @Test fun `paused or idle playback does not enter`() {
        assertFalse(shouldEnterPip(wantsToPlay = false, setting = true, supported = true))
    }

    @Test fun `the setting and device support are both required`() {
        assertFalse(shouldEnterPip(wantsToPlay = true, setting = false, supported = true))
        assertFalse(shouldEnterPip(wantsToPlay = true, setting = true, supported = false))
    }

    @Test fun `the button needs support, the setting and a video`() {
        assertTrue(pipAvailable(supported = true, setting = true, hasVideo = true))
        assertFalse(pipAvailable(supported = false, setting = true, hasVideo = true))
        assertFalse(pipAvailable(supported = true, setting = false, hasVideo = true))
        assertFalse(pipAvailable(supported = true, setting = true, hasVideo = false))
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

    @Test fun `the pixel aspect ratio widens the shape`() {
        assertEquals(PipRatio(1440, 1080), pipAspect(1080, 1080, 4f / 3f))
    }

    @Test fun `extreme shapes are clamped to 2_39 to 1 and 1 to 2_39`() {
        assertEquals(PipRatio(239, 100), pipAspect(3000, 1000))
        assertEquals(PipRatio(100, 239), pipAspect(500, 2000))
        assertEquals(PipRatio(239, 100), pipAspect(239, 100))
    }

    @Test fun `a fraction that only rounds past the limit is clamped`() {
        // 2.3894:1 at a tiny height rounds to 24:10 = 2.4:1, which Android would reject.
        assertEquals(PipRatio(239, 100), pipAspect(24, 10))
        val r = pipAspect(2389, 1000)
        assertTrue(r.width * 100 <= 239 * r.height)
    }

    @Test fun `actions are Pause while playing and Play while paused, plus Skip for TV`() {
        assertEquals(listOf(PipAction.Pause), pipActions(hasVideo = true, wantsToPlay = true, tv = false))
        assertEquals(listOf(PipAction.Play), pipActions(hasVideo = true, wantsToPlay = false, tv = false))
        assertEquals(listOf(PipAction.Pause, PipAction.Skip), pipActions(hasVideo = true, wantsToPlay = true, tv = true))
        assertEquals(emptyList(), pipActions(hasVideo = false, wantsToPlay = false, tv = true))
    }
}
