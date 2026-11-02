package io.github.dodwmd.ytclassic.data

import kotlinx.serialization.Serializable

/** One subtitle track the server offers: [auto] marks YouTube's automatic captions. */
@Serializable
data class SubTrack(val lang: String, val name: String = "", val auto: Boolean = false)

@Serializable
data class SubTracks(val tracks: List<SubTrack> = emptyList())

/** The menu label of a track. */
fun SubTrack.label(): String = (name.ifBlank { lang }) + if (auto) " (auto)" else ""

private fun primary(lang: String) = lang.substringBefore('-').substringBefore('_').lowercase()

/**
 * The language to start on: the saved one if the video has it exactly, else a track matching the saved language, then the
 * device's language (exact, then the same primary subtag: manual tracks before automatic ones, so "en" finds "en-GB" and
 * "en-orig"), else the first manual track, else the first track; null when there are none.
 */
fun chooseLang(stored: String, tracks: List<SubTrack>, device: String = ""): String? {
    tracks.firstOrNull { it.lang == stored }?.let { return it.lang }
    for (want in listOf(stored, device).filter { it.isNotEmpty() }) {
        (tracks.firstOrNull { it.lang.equals(want, ignoreCase = true) }
            ?: tracks.firstOrNull { !it.auto && primary(it.lang) == primary(want) }
            ?: tracks.firstOrNull { it.auto && primary(it.lang) == primary(want) })?.let { return it.lang }
    }
    return (tracks.firstOrNull { !it.auto } ?: tracks.firstOrNull())?.lang
}

/** One caption: shown from [startMs] (inclusive) to [endMs] (exclusive), at most two lines of plain text. */
data class Cue(val startMs: Long, val endMs: Long, val text: String)

private const val MAX_LINE = 160
private const val MAX_LINES = 2
private const val MAX_MANUAL_LINES = 6
private val TIME = Regex("""^(?:(\d+):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})$""")
private val BLOCKS = Regex("\n{2,}")
private val SKIPPED_BLOCK = Regex("^(NOTE|STYLE|REGION)\\b")
private val VTT_TAG = Regex("""^(?:/?(?:c|v|i|b|u|lang|ruby|rt)(?:[. ][^<>]*)?|\d\d?:[\d:.]+)$""", RegexOption.IGNORE_CASE)
private val SPACES = Regex("\\s+")
private val ENTITY = Regex("&(amp|lt|gt|nbsp|quot|#39);")

/** "mm:ss.mmm" or "hh:mm:ss.mmm" (a comma works too) in milliseconds, or null; minutes and seconds must be below 60. */
fun parseVttTime(s: String): Long? {
    val m = TIME.find(s) ?: return null
    val (h, min, sec, frac) = m.destructured
    return (h.ifEmpty { "0" }.toLong() * 3600 + min.toLong() * 60 + sec.toLong()) * 1000 + frac.padEnd(3, '0').toLong()
}

/** Removes only real WebVTT tag tokens in a linear scan, repeated until stable (removing a tag can join the text around it into another); any other "<" stays. */
private fun stripTags(text: String): String {
    var t = text
    do {
        val prev = t
        val out = StringBuilder()
        var at = 0
        var lt = t.indexOf('<')
        while (lt >= 0) {
            val gt = t.indexOf('>', lt)
            if (gt < 0) break
            val real = VTT_TAG.matches(t.substring(lt + 1, gt))
            out.append(t, at, if (real) lt else lt + 1)
            at = if (real) gt + 1 else lt + 1
            lt = t.indexOf('<', at)
        }
        t = out.append(t, at, t.length).toString()
    } while (t != prev)
    return t
}

private fun cleanLine(l: String): String = stripTags(l).replace(ENTITY) {
    when (it.groupValues[1]) { "amp" -> "&"; "lt" -> "<"; "gt" -> ">"; "nbsp" -> " "; "quot" -> "\""; else -> "'" }
}.replace(SPACES, " ").trim()

/**
 * WebVTT to cues sorted by start. NOTE, STYLE and REGION blocks, bad timings and empty cues are skipped; markup is
 * stripped (the result is plain text). With [auto], lines the previous cue already showed are dropped: YouTube's
 * automatic captions roll, repeating the previous line(s) in each new cue. Manual tracks keep every line.
 */
fun parseVtt(text: String, auto: Boolean = false): List<Cue> {
    val cues = ArrayList<Cue>()
    var prev: List<String> = emptyList()
    for (block in text.trimStart(Char(0xFEFF)).replace("\r\n", "\n").replace('\r', '\n').split(BLOCKS)) {
        val lines = block.split("\n")
        val i = lines.indexOfFirst { it.contains("-->") }
        if (i < 0 || i > 1 || SKIPPED_BLOCK.containsMatchIn(lines[0])) continue
        val (a, b) = lines[i].split("-->", limit = 2)
        val start = parseVttTime(a.trim()) ?: continue
        val end = parseVttTime(b.trim().split(SPACES)[0]) ?: continue
        if (end <= start) continue
        val all = lines.drop(i + 1).map(::cleanLine).filter { it.isNotEmpty() }
        val shown = (if (auto) all.filter { it !in prev }.takeLast(MAX_LINES) else all.take(MAX_MANUAL_LINES)).joinToString("\n") { it.take(MAX_LINE) }
        prev = all
        if (shown.isNotEmpty()) cues.add(Cue(start, end, shown))
    }
    return cues.sortedBy { it.startMs }
}

/** Cues looked up by time. [positionMs] is the ABSOLUTE position (what PlaybackHost reports), never the stream-relative one. */
class CueTrack(private val cues: List<Cue>) {
    val isEmpty get() = cues.isEmpty()

    // latestEnd[i] is the latest end among cues 0..i: a long cue early in the list is still found behind many short ones.
    private val latestEnd = LongArray(cues.size).also { var m = 0L; cues.forEachIndexed { i, c -> m = maxOf(m, c.endMs); it[i] = m } }

    /** The text to show at [positionMs]: binary search for the last cue started, then back through the cues that may still be showing. */
    fun textAt(positionMs: Long): String {
        var lo = 0
        var hi = cues.size
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            if (cues[mid].startMs <= positionMs) lo = mid + 1 else hi = mid
        }
        val active = ArrayList<String>()
        var i = lo - 1
        while (i >= 0 && latestEnd[i] > positionMs && active.size < MAX_ACTIVE) {
            if (cues[i].endMs > positionMs) active.add(0, cues[i].text)
            i--
        }
        return active.joinToString("\n").split("\n").takeLast(MAX_SHOWN_LINES).joinToString("\n")
    }

    companion object { val EMPTY = CueTrack(emptyList()) }
}

private const val MAX_ACTIVE = 3
private const val MAX_SHOWN_LINES = 4
