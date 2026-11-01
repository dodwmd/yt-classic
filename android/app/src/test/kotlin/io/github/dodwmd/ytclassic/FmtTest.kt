package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.formatSeconds
import io.github.dodwmd.ytclassic.data.formatViews
import io.github.dodwmd.ytclassic.data.joinParts
import io.github.dodwmd.ytclassic.data.timeAgo
import io.github.dodwmd.ytclassic.data.viewsText
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals

// Same cases as frontend/test/fmt.test.js, so the web and Android apps format identically.
class FmtTest {
    @Test
    fun formatSecondsCases() {
        assertEquals("1:05", formatSeconds(65))
        assertEquals("3:33", formatSeconds(213))
        assertEquals("1:02:03", formatSeconds(3723))
        assertEquals("0:00", formatSeconds(0))
    }

    @Test
    fun timeAgoBoundaries() {
        val now = Instant.parse("2027-01-01T00:00:00Z").toEpochMilli()
        fun ago(days: Double) = timeAgo(Instant.ofEpochMilli(now - (days * 86_400_000).toLong()).toString(), now)
        assertEquals("2 days ago", ago(2.0))
        assertEquals("11 months ago", ago(364.0)) // not "12 months"
        assertEquals("1 year ago", ago(365.0))
        assertEquals("just now", ago(0.0001))
        assertEquals("", timeAgo("", now))
        assertEquals("", timeAgo(null, now))
        assertEquals("", timeAgo("garbage", now))
        assertEquals("1 day ago", timeAgo("2026-12-31T00:00:00+00:00", now)) // RSS-style offset
    }

    @Test
    fun viewsAndJoins() {
        assertEquals("1,234 views", formatViews("1234"))
        assertEquals("", formatViews(""))
        assertEquals("", formatViews(null))
        assertEquals("1.2M views", viewsText("1.2M"))
        assertEquals("3K watching", viewsText("3K watching"))
        assertEquals("a · b", joinParts("a", "", null, "b"))
    }
}
