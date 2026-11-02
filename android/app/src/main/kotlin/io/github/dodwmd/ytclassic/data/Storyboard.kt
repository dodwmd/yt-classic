package io.github.dodwmd.ytclassic.data

import kotlinx.serialization.Serializable
import kotlin.math.roundToInt

/** The server's storyboard descriptor: [w]x[h] px tiles, [cols]x[rows] per sheet, [count] tiles in all, one every [interval] seconds, over [sheets] sheets. */
@Serializable
data class Tiles(val w: Int = 0, val h: Int = 0, val cols: Int = 0, val rows: Int = 0, val count: Int = 0, val interval: Double = 0.0, val sheets: Int = 0)

@Serializable
data class Storyboard(val tiles: Tiles = Tiles(), val duration: Double = 0.0)

/** Where a tile sits: sheet number and its pixel rectangle inside that sheet. */
data class TileRect(val sheet: Int, val x: Int, val y: Int, val w: Int, val h: Int)

/** False for a descriptor that could not be mapped (a broken or empty answer): previews are then simply off. */
fun Tiles.usable(): Boolean = w > 0 && h > 0 && cols > 0 && rows > 0 && count > 0 && interval > 0.0 && sheets > 0 && interval.isFinite()

/** The tile showing [seconds]: before the start is the first tile, the end (and anything past it) the last one. */
fun Tiles.locate(seconds: Float): TileRect {
    val i = if (seconds.isNaN()) 0 else (seconds / interval).coerceIn(0.0, (count - 1).toDouble()).toInt()
    val per = cols * rows
    val k = i % per
    return TileRect(i / per, (k % cols) * w, (k / cols) * h, w, h)
}

/** Left edge (px) of a bubble centred over [frac] of a slider track that starts [inset] px into the slider, kept inside the window. */
fun bubbleLeft(anchorLeft: Int, anchorWidth: Int, inset: Int, frac: Float, bubbleWidth: Int, windowWidth: Int): Int {
    val span = (anchorWidth - 2 * inset).coerceAtLeast(0)
    val centre = anchorLeft + inset + span * frac.coerceIn(0f, 1f)
    return (centre - bubbleWidth / 2f).roundToInt().coerceIn(0, (windowWidth - bubbleWidth).coerceAtLeast(0))
}

/** An LRU bounded by the total [sizeOf] of its values (oldest used out first); a value larger than the bound is not kept. */
class ByteBoundedLru<K, V : Any>(private val maxBytes: Long, private val sizeOf: (V) -> Long) {
    private val map = LinkedHashMap<K, V>(16, 0.75f, true)
    var bytes = 0L
        private set
    val size get() = map.size

    @Synchronized
    operator fun get(key: K): V? = map[key]

    @Synchronized
    fun put(key: K, value: V) {
        map.remove(key)?.let { bytes -= sizeOf(it) }
        val s = sizeOf(value)
        if (s > maxBytes) return
        map[key] = value
        bytes += s
        val it = map.entries.iterator()
        while (bytes > maxBytes && it.hasNext()) {
            bytes -= sizeOf(it.next().value)
            it.remove()
        }
    }
}
