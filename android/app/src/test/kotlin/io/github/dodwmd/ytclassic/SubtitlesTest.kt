package io.github.dodwmd.ytclassic

import com.sun.net.httpserver.HttpServer
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.Cue
import io.github.dodwmd.ytclassic.data.CueTrack
import io.github.dodwmd.ytclassic.data.SubTrack
import io.github.dodwmd.ytclassic.data.SubTracks
import io.github.dodwmd.ytclassic.data.ApiJson
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.chooseLang
import io.github.dodwmd.ytclassic.data.label
import io.github.dodwmd.ytclassic.data.parseVtt
import io.github.dodwmd.ytclassic.data.parseVttTime
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

private fun res(name: String) = SubtitlesTest::class.java.getResource("/$name")!!.readText()

class SubtitlesTest {
    @Test
    fun timeFormats() {
        assertEquals(1500L, parseVttTime("00:01.500"))
        assertEquals(3_601_250L, parseVttTime("01:00:01.250"))
        assertEquals(2500L, parseVttTime("00:02,5"))
        assertEquals(61_000L, parseVttTime("1:01.000"))
        for (bad in listOf("", "1.5", "00:00", "aa:bb.ccc", "00:61:00", "61:00.000", "00:60.000", "1:60:00.000")) assertNull(parseVttTime(bad), bad)
        assertEquals(3_599_999L, parseVttTime("59:59.999"))
    }

    @Test
    fun manualTrackSkipsNotesStyleAndEmptyCuesAndStripsMarkup() {
        val cues = parseVtt(res("subs-manual.vtt"))
        assertEquals(
            listOf(
                Cue(1000, 3500, "Hello & welcome"),
                Cue(3500, 5000, "line one\nline two\nline three"), // manual cues keep their lines
                Cue(3_600_250, 3_602_000, "An hour in"),
            ),
            cues,
        )
    }

    @Test
    fun onlyRealTagsAreStripped() {
        fun t(x: String) = parseVtt("WEBVTT\n\n00:00.000 --> 00:01.000\n$x\n").firstOrNull()?.text
        assertEquals("<script>alert(1)", t("<<b>script>alert(1)</b>"))
        assertEquals("a b xy z u w v", t("a <v Bob.loud>b</v> <ruby>x<rt>y</rt></ruby> <lang en>z</lang> <u>u</u> <00:01.5>w <00:00:01.500>v"))
        assertEquals("<script>x</script> <bad> <b", t("<script>x</script> <bad> <b"))
    }

    @Test
    fun crlfBomAndGarbage() {
        assertEquals(listOf(Cue(0, 1000, "a\nb")), parseVtt("﻿WEBVTT\r\n\r\n00:00.000 --> 00:01.000\r\na\r\nb\r\n"))
        assertEquals(emptyList(), parseVtt(""))
        assertEquals(emptyList(), parseVtt("<script>alert(1)</script>"))
        assertEquals(emptyList(), parseVtt("WEBVTT\n\n00:05.000 --> 00:04.000\nbackwards\n"))
        assertEquals(160, parseVtt("WEBVTT\n\n00:00.000 --> 00:01.000\n" + "x".repeat(500) + "\n").single().text.length)
    }

    @Test
    fun autoCaptionRollingDuplicatesAreDroppedButManualKeepsThem() {
        val vtt = res("subs-auto.vtt")
        assertEquals(
            listOf(Cue(0, 2000, "hello\nworld again"), Cue(2010, 4000, "next line"), Cue(4010, 6000, "last")),
            parseVtt(vtt, auto = true),
        )
        assertEquals(5, parseVtt(vtt, auto = false).size)
    }

    @Test
    fun lookupIsAbsoluteAndExactAtTheEdges() {
        val t = CueTrack(listOf(Cue(1000, 2000, "a"), Cue(3000, 6000, "b"), Cue(4000, 5000, "c"), Cue(10_000, 11_000, "d")))
        assertEquals("", t.textAt(999))
        assertEquals("a", t.textAt(1000))
        assertEquals("a", t.textAt(1999))
        assertEquals("", t.textAt(2000))
        assertEquals("b\nc", t.textAt(4500))
        assertEquals("b", t.textAt(5500))
        assertEquals("d", t.textAt(10_500))
        assertEquals("", t.textAt(Long.MAX_VALUE))
        assertEquals("", CueTrack.EMPTY.textAt(5))
        // After a seek restart the host reports base + stream time, e.g. 300 s + 2.2 s: only the cue at 302.2 s matches.
        val seeked = CueTrack(listOf(Cue(5000, 9000, "early"), Cue(302_000, 304_000, "after seek")))
        assertEquals("", seeked.textAt(2200), "the stream-relative time must not match")
        assertEquals("after seek", seeked.textAt(300_000 + 2200))
        // A long cue early in the list is still showing behind many short ones.
        val longLived = CueTrack(listOf(Cue(0, 1_000_000, "long")) + (0 until 50).map { Cue(10_000L + it * 1000, 10_500L + it * 1000, "s$it") })
        assertEquals("long\ns0", longLived.textAt(10_200))
        assertEquals("long", longLived.textAt(59_900))
        assertEquals("", longLived.textAt(1_000_000))
        val big = CueTrack((0 until 5000).map { Cue(it * 2000L, it * 2000L + 1000, "$it") })
        assertEquals("2499", big.textAt(4_998_500))
        assertEquals("", big.textAt(4_999_500))
    }

    @Test
    fun languageChoiceAndLabels() {
        val tracks = SubTracks.serializer().let { ApiJson.decodeFromString(it, res("subs-tracks.json")) }.tracks
        assertEquals(4, tracks.size)
        assertEquals("fr", chooseLang("fr", tracks))
        assertEquals("en", chooseLang("xx", tracks))
        assertEquals("en", chooseLang("", tracks))
        assertEquals("de", chooseLang("", tracks, device = "de-DE"), "the device language before the first manual track")
        assertEquals("fr", chooseLang("", tracks, device = "fr_FR"), "an automatic track when no manual one matches")
        assertEquals("en", chooseLang("", tracks, device = "ja-JP"))
        assertEquals("en-GB", chooseLang("en-US", listOf(SubTrack("de"), SubTrack("en-GB")), device = "de"), "the saved language's primary subtag beats the device")
        assertEquals("en-orig", chooseLang("en", listOf(SubTrack("de"), SubTrack("en-orig", auto = true))))
        assertEquals("en", chooseLang("EN", tracks), "case-insensitive")
        assertEquals("de", chooseLang("xx", tracks, device = "de-AT"), "an unknown saved language falls to the device language")
        assertEquals("fr", chooseLang("", listOf(SubTrack("fr", auto = true))))
        assertNull(chooseLang("en", emptyList()))
        assertEquals("English", tracks[0].label())
        assertEquals("English (Original) (auto)", tracks[2].label())
        assertEquals("fr (auto)", tracks[3].label())
    }

    private lateinit var server: HttpServer
    private val seen = mutableListOf<String>()

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            seen += ex.requestURI.path + " auth=" + ex.requestHeaders.getFirst("Authorization")
            val (status, type, body) = when (ex.requestURI.path) {
                "/api/video/AAAAAAAAAAA/subs" -> Triple(200, "application/json", res("subs-tracks.json"))
                "/api/video/AAAAAAAAAAA/subs/en.vtt" -> Triple(200, "text/vtt", res("subs-manual.vtt"))
                else -> Triple(404, "application/json", """{"error":"This video has no subtitles in that language.","code":"no-subtitles","retryable":false}""")
            }
            val bytes = body.toByteArray()
            ex.responseHeaders.add("Content-Type", type)
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @AfterTest
    fun stop() = server.stop(0)

    private fun api(token: String = "") = YtApi(server = { "127.0.0.1:${server.address.port}" }, token = { token })

    @Test
    fun apiFetchesTracksAndVttWithTheToken() = runBlocking {
        val a = api("secret-token")
        assertEquals(4, a.subTracks("AAAAAAAAAAA").size)
        assertTrue(a.subVtt("AAAAAAAAAAA", "en").startsWith("WEBVTT"))
        assertTrue(seen.all { it.endsWith("auth=Bearer secret-token") }, seen.toString())
    }

    @Test
    fun noSubtitlesIsAClassifiedError() {
        val e = assertFailsWith<ApiException> { runBlocking { api().subVtt("AAAAAAAAAAA", "ja") } }
        assertEquals("no-subtitles", e.code)
    }
}
