package io.github.dodwmd.ytclassic.data

import java.text.NumberFormat
import java.time.OffsetDateTime
import java.util.Locale

// Display formatting, ported from frontend/public/js/fmt.js (same behaviour, same test cases).

fun formatSeconds(total: Long): String {
    val h = total / 3600
    val m = total % 3600 / 60
    val s = total % 60
    return if (h > 0) "%d:%02d:%02d".format(h, m, s) else "%d:%02d".format(m, s)
}

/** "2 days ago"; empty for missing or invalid dates. */
fun timeAgo(iso: String?, nowMillis: Long = System.currentTimeMillis()): String {
    val then = try {
        OffsetDateTime.parse(iso ?: return "").toInstant().toEpochMilli()
    } catch (_: Exception) {
        return ""
    }
    val secs = maxOf(0L, (nowMillis - then) / 1000)
    val units = listOf("year" to 31_536_000L, "month" to 2_592_000L, "week" to 604_800L, "day" to 86_400L, "hour" to 3_600L, "minute" to 60L)
    for ((name, size) in units) {
        var n = secs / size
        if (name == "month") n = minOf(n, 11) // 360-364 days is still "11 months", not "12"
        if (n >= 1) return "$n $name${if (n > 1) "s" else ""} ago"
    }
    return "just now"
}

/** "1,234 views"; empty when unknown. */
fun formatViews(n: String?): String {
    val v = n?.toLongOrNull() ?: return ""
    return "${NumberFormat.getIntegerInstance(Locale.US).format(v)} views"
}

/** Display strings from the watch-next feed ("1.2M", "3K watching"): add "views" only when it isn't there. */
fun viewsText(v: String): String = if (Regex("view|watching", RegexOption.IGNORE_CASE).containsMatchIn(v)) v else "$v views"

fun joinParts(vararg parts: String?): String = parts.filter { !it.isNullOrEmpty() }.joinToString(" · ")
