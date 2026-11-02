package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.SubTrack
import io.github.dodwmd.ytclassic.player.CaptionPrefs
import io.github.dodwmd.ytclassic.player.CaptionSource
import io.github.dodwmd.ytclassic.player.CaptionsState
import io.github.dodwmd.ytclassic.player.COMPACT_ROW_DP
import io.github.dodwmd.ytclassic.player.NOTICE_NO_SUBTITLES
import io.github.dodwmd.ytclassic.player.NOTICE_UNAVAILABLE
import io.github.dodwmd.ytclassic.player.TrackLoad
import io.github.dodwmd.ytclassic.player.TransportItem
import io.github.dodwmd.ytclassic.player.transportPlan
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

private val EN = SubTrack("en", "English")
private val DE = SubTrack("de", "German")
private val VTT = "WEBVTT\n\n00:00:05.000 --> 00:00:09.000\nhello\n\n00:05:02.000 --> 00:05:04.000\nafter seek\n"

private class FakeSource(var tracks: List<SubTrack> = listOf(EN, DE), var failTracks: Boolean = false, var failVtt: Boolean = false) : CaptionSource {
    val trackCalls = mutableListOf<String>()
    val vttCalls = mutableListOf<String>()
    override suspend fun tracks(videoId: String, pref: String): List<SubTrack> {
        trackCalls += pref
        if (failTracks) throw RuntimeException("down")
        return tracks
    }
    override suspend fun vtt(videoId: String, lang: String): String {
        vttCalls += lang
        if (failVtt) throw RuntimeException("down")
        return VTT
    }
}

private class FakePrefs(var on: Boolean = false, var lang: String = "") : CaptionPrefs {
    override suspend fun on() = on
    override suspend fun lang() = lang
    override suspend fun save(on: Boolean, lang: String) { this.on = on; if (lang.isNotEmpty()) this.lang = lang }
}

class CaptionsStateTest {
    private fun state(src: CaptionSource, prefs: CaptionPrefs, device: String = "") = CaptionsState("AAAAAAAAAAA", src, prefs, device, Dispatchers.Unconfined)

    @Test
    fun offByDefaultAndNothingIsFetchedUntilTheMenuOpens() = runBlocking {
        val src = FakeSource()
        val s = state(src, FakePrefs())
        s.start()
        assertFalse(s.enabled)
        assertEquals(TrackLoad.NotAsked, s.load)
        assertTrue(src.trackCalls.isEmpty() && src.vttCalls.isEmpty())
        s.ensureTracks()
        s.ensureTracks() // opening the menu again does not ask again
        assertEquals(listOf(""), src.trackCalls)
        assertEquals("en", s.lang)
        assertTrue(src.vttCalls.isEmpty(), "still off: no WebVTT")
    }

    @Test
    fun leftOnAsksForTracksWithTheSavedLanguageAndFollowsTheAbsolutePosition() = runBlocking {
        val src = FakeSource()
        val s = state(src, FakePrefs(on = true, lang = "de"))
        s.start()
        s.loadCues()
        assertEquals(listOf("de"), src.trackCalls)
        assertEquals(listOf("de"), src.vttCalls)
        s.tick(6_000)
        assertEquals("hello", s.text)
        s.tick(2_200) // stream-relative time after a seek restart at 300 s must not match
        assertEquals("", s.text)
        s.tick(300_000 + 2_200)
        assertEquals("after seek", s.text)
    }

    @Test
    fun choosingSavesAndOffClearsTheText() = runBlocking {
        val prefs = FakePrefs()
        val s = state(FakeSource(), prefs)
        s.start(); s.ensureTracks()
        s.choose("de")
        assertTrue(s.enabled && prefs.on && prefs.lang == "de")
        s.loadCues(); s.tick(6000)
        assertEquals("hello", s.text)
        s.choose(null)
        assertFalse(s.enabled || prefs.on)
        assertEquals("", s.text)
        assertEquals("de", prefs.lang, "the language is kept for next time")
    }

    @Test
    fun aFailedDownloadKeepsItsNoticeUntilClearedOrReplaced() = runBlocking {
        val src = FakeSource(failVtt = true)
        val s = state(src, FakePrefs())
        s.ensureTracks()
        s.choose("en")
        s.loadCues()
        assertEquals(NOTICE_UNAVAILABLE, s.notice)
        assertFalse(s.enabled)
        // The effect keyed on `enabled` runs loadCues again: it must not erase the notice.
        s.loadCues()
        assertEquals(NOTICE_UNAVAILABLE, s.notice)
        s.clearNotice()
        assertEquals("", s.notice)
        s.choose("en")
        assertEquals("", s.notice)
    }

    @Test
    fun noTracksAndFailingTrackListsSayWhy() = runBlocking {
        val none = state(FakeSource(tracks = emptyList()), FakePrefs(on = true))
        none.start()
        assertEquals(NOTICE_NO_SUBTITLES, none.notice)
        assertFalse(none.enabled)
        val failing = FakeSource(failTracks = true)
        val s = state(failing, FakePrefs(on = true))
        s.start()
        assertEquals(NOTICE_UNAVAILABLE, s.notice)
        assertEquals(TrackLoad.Failed, s.load)
        failing.failTracks = false
        s.ensureTracks() // a failed list is asked for again
        assertEquals(TrackLoad.Loaded, s.load)
        assertEquals(2, failing.trackCalls.size)
    }

    @Test
    fun togglingOffAndOnReusesTheDownloadedTrack() = runBlocking {
        val src = FakeSource()
        val s = state(src, FakePrefs())
        s.ensureTracks()
        s.choose("en"); s.loadCues()
        s.choose(null); s.loadCues()
        s.choose("en"); s.loadCues()
        s.tick(6000)
        assertEquals("hello", s.text)
        assertEquals(listOf("en"), src.vttCalls)
        s.choose("de"); s.loadCues()
        assertEquals(listOf("en", "de"), src.vttCalls)
    }

    @Test
    fun deviceLanguagePicksTheStartingTrack() = runBlocking {
        val s = state(FakeSource(), FakePrefs(), device = "de-DE")
        s.ensureTracks()
        assertEquals("de", s.lang)
    }

    @Test
    fun transportKeepsOnlyTheEssentialsInlineOnNarrowRows() {
        val all = listOf(TransportItem.Speed, TransportItem.Captions, TransportItem.Pip, TransportItem.Skip, TransportItem.Stop)
        val wide = transportPlan(COMPACT_ROW_DP, 1f, pip = true, tv = true)
        assertEquals(all, wide.inline)
        assertTrue(wide.overflow.isEmpty())
        val narrow = transportPlan(360f, 1f, pip = true, tv = true)
        assertTrue(narrow.inline.isEmpty())
        assertEquals(all, narrow.overflow)
        assertEquals(listOf(TransportItem.Speed, TransportItem.Captions), transportPlan(360f, 1f, pip = false, tv = false).overflow)
        assertEquals(listOf(TransportItem.Speed, TransportItem.Captions), transportPlan(500f, 1f, pip = false, tv = false).inline)
        // A larger font needs a wider row: the same 500 dp is compact at 2x.
        assertTrue(transportPlan(500f, 2f, pip = true, tv = false).inline.isEmpty())
        assertFalse(transportPlan(900f, 2f, pip = true, tv = false).inline.isEmpty())
        assertEquals(wide.inline, transportPlan(COMPACT_ROW_DP, 0.85f, pip = true, tv = true).inline, "a smaller font never lowers the threshold")
    }
}
