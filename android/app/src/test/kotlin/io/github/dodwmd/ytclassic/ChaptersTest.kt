package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.Chapter
import io.github.dodwmd.ytclassic.data.VideoResponse
import io.github.dodwmd.ytclassic.data.chapterIndexAt
import io.github.dodwmd.ytclassic.data.timestampRanges
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class ChaptersTest {
    private val json = Json { ignoreUnknownKeys = true }
    private fun fixture() = json.decodeFromString<VideoResponse>(javaClass.getResource("/video-chapters.json")!!.readText())
    private fun texts(s: String, d: Long = 3600) = timestampRanges(s, d).map { s.substring(it.from, it.to) to it.seconds }

    @Test
    fun chaptersComeFromTheServerResponse() {
        val r = fixture()
        assertEquals(listOf(0L, 90L, 240L, 3723L), r.chapters.map { it.start })
        assertEquals("Intro", r.chapters[0].title)
        assertEquals(4000L, r.chapters.last().end)
        assertTrue(json.decodeFromString<VideoResponse>(javaClass.getResource("/video.json")!!.readText()).chapters.isEmpty(), "older responses have none")
    }

    @Test
    fun descriptionLinksFollowTheSharedRule() {
        val v = fixture().video
        // The list's four times and the "4:00" in prose are links; the port in the URL, 99:00 (past the end) and 12:345 are not.
        assertEquals(listOf("0:00" to 0L, "1:30" to 90L, "4:00" to 240L, "1:02:03" to 3723L, "4:00" to 240L), texts(v.description, v.durationSeconds!!))
        for (t in listOf("https://x.com:8080/a", "http://host:1234", "12:345", "1:02:03:04", "10:00pm", "ratio 16:9", "1:75", "1:75:00", "file:12:30")) assertEquals(emptyList(), texts(t), t)
        assertEquals(listOf("1:00" to 60L, "2:00" to 120L), texts("1:00 2:00 3:00", 150))
        assertEquals(listOf("2:15" to 135L), texts("(2:15) Title"))
    }

    @Test
    fun sharedTimestampCasesMatchTheWebRule() {
        val cases = Json.parseToJsonElement(javaClass.getResource("/timestamp-links.json")!!.readText()).jsonObject["cases"]!!.jsonArray
        assertTrue(cases.size >= 10)
        for (c in cases.map { it.jsonObject }) {
            val text = c["text"]!!.jsonPrimitive.content
            val duration = c["duration"]!!.jsonPrimitive.longOrNull ?: 0L // a missing duration is 0 on Android
            val expected = c["links"]!!.jsonArray.map { it.jsonArray[0].jsonPrimitive.content to it.jsonArray[1].jsonPrimitive.long }
            assertEquals(expected, texts(text, duration), c["name"]!!.jsonPrimitive.content)
        }
    }

    @Test
    fun malformedChaptersNeverFailTheResponse() {
        val base = """{"video":{"id":"a","title":"t","channelId":"","channelTitle":"","description":"","publishedAt":"2026-01-01T00:00:00Z"},"chapters":"""
        fun parse(chapters: String) = json.decodeFromString<VideoResponse>("$base$chapters}").chapters
        assertEquals(listOf("ok"), parse("""[{"start":0,"title":"ok"},{"start":"x","title":"bad"},{"title":"no start"},7,null,{"start":-5,"title":"neg"},{"start":3,"title":" "}]""").map { it.title })
        assertEquals(emptyList(), parse("\"nope\""))
        assertEquals(emptyList(), parse("null"))
        assertEquals(emptyList(), parse("{}"))
    }

    @Test
    fun theCurrentChapterFollowsTheAbsolutePosition() {
        val ch = listOf(Chapter(0, 60, "a"), Chapter(60, 300, "b"), Chapter(300, 400, "c"))
        assertEquals(listOf(0, 0, 1, 1, 2, 2), listOf(0L, 59, 60, 299, 300, 9999).map { chapterIndexAt(ch, it) })
        assertEquals(-1, chapterIndexAt(listOf(Chapter(10, 20, "x")), 5))
    }
}
