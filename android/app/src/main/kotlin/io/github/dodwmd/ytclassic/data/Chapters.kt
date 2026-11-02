package io.github.dodwmd.ytclassic.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonTransformingSerializer

/** A chapter from the server (`chapters` in /api/video/:id): absolute seconds. */
@Serializable
data class Chapter(val start: Long, val end: Long = start, val title: String)

/** `chapters` in a response: a malformed entry (or a malformed list) is dropped, it never fails the whole video response. */
object LenientChapters : JsonTransformingSerializer<List<Chapter>>(ListSerializer(Chapter.serializer())) {
    private val strict = Json { ignoreUnknownKeys = true }
    override fun transformDeserialize(element: JsonElement): JsonElement {
        if (element !is JsonArray) return JsonArray(emptyList())
        return JsonArray(element.filter {
            runCatching { strict.decodeFromJsonElement(Chapter.serializer(), it) }.getOrNull()?.let { c -> c.start >= 0 && c.title.isNotBlank() } == true
        })
    }
}

/** A timestamp in a description: characters [from, to) are the text, [seconds] the target. */
data class TimestampRange(val from: Int, val to: Int, val seconds: Long)

// Same rule as frontend/public/js/chapters.js (README, "Chapters and timestamps"): h:mm:ss or m:ss, not part of a URL or a longer token.
private val TIME = Regex("""(?<![\w:/.@#?=&%])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?!\w|:\d|[/.]\w)""")

/** The timestamps of [text] that fall inside a video of [duration] seconds. */
fun timestampRanges(text: String, duration: Long): List<TimestampRange> = TIME.findAll(text).mapNotNull { m ->
    val h = m.groupValues[1].toLongOrNull() ?: 0L
    val min = m.groupValues[2].toLong()
    val sec = m.groupValues[3].toLong()
    val t = h * 3600 + min * 60 + sec
    if (sec > 59 || (m.groupValues[1].isNotEmpty() && min > 59) || t >= duration) null else TimestampRange(m.range.first, m.range.last + 1, t)
}.toList()

/** Index of the chapter playing at [t] seconds (-1 before the first). */
fun chapterIndexAt(chapters: List<Chapter>, t: Long): Int = chapters.indexOfLast { it.start <= t }
