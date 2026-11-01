package io.github.dodwmd.ytclassic.data

import java.io.InputStream

/** The backend refuses larger import bodies (413); checking here saves uploading a file that cannot work. */
const val MAX_IMPORT_BYTES = 1024 * 1024

private fun InputStream.readBytes(limit: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buf = ByteArray(8192)
    while (out.size() < limit) {
        val n = read(buf, 0, minOf(buf.size, limit - out.size()))
        if (n < 0) break
        out.write(buf, 0, n)
    }
    return out.toByteArray()
}

/** The bytes of [input], or null when it holds more than [max] (at most max + 1 are read). */
fun readBytesLimited(input: InputStream, max: Int = MAX_IMPORT_BYTES): ByteArray? {
    val bytes = input.readBytes(max + 1)
    return if (bytes.size > max) null else bytes
}

/** One-line description of an import, mirroring the web page ("Added 3, 2 already subscribed. Skipped ..."). */
fun importSummary(r: ImportResult): String {
    val skipped = listOfNotNull(
        r.skipped.invalid.takeIf { it > 0 }?.let { "$it invalid" },
        r.skipped.handles.takeIf { it > 0 }?.let { "$it @handle (can't be resolved)" },
        r.skipped.full.takeIf { it > 0 }?.let { "$it over the limit of 500" },
    )
    val skippedText = if (skipped.isEmpty()) "" else " Skipped ${skipped.joinToString(", ")}."
    return "Added ${r.added}, ${r.existing} already subscribed.$skippedText You now have ${r.total} ${if (r.total == 1) "subscription" else "subscriptions"}."
}
