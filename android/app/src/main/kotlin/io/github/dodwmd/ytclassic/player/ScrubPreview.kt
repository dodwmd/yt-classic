package io.github.dodwmd.ytclassic.player

import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.ByteBoundedLru
import io.github.dodwmd.ytclassic.data.Storyboard
import io.github.dodwmd.ytclassic.data.Tiles
import io.github.dodwmd.ytclassic.data.usable
import kotlinx.coroutines.CancellationException

/** Where the previews come from: the server's descriptor (null when the video has no storyboard) and its sheets as image bytes. */
interface StoryboardSource {
    suspend fun storyboard(videoId: String): Storyboard?
    suspend fun sheet(videoId: String, n: Int): ByteArray
}

const val SHEET_CACHE_BYTES = 8L * 1024 * 1024

/**
 * Scrub previews for one video. The descriptor is asked for once (a video without a storyboard is remembered, a failed
 * request is tried again the next time); each sheet is fetched and decoded once and kept in a byte-bounded cache.
 * [B] is the decoded image (an ImageBitmap in the app).
 */
class ScrubPreview<B : Any>(
    private val videoId: String,
    private val source: StoryboardSource,
    private val decode: (ByteArray) -> B?,
    sizeOf: (B) -> Long,
    cacheBytes: Long = SHEET_CACHE_BYTES,
) {
    private val cache = ByteBoundedLru<Int, B>(cacheBytes, sizeOf)
    private var asked = false
    private var tiles: Tiles? = null

    /** The mapping, or null while unknown, for a video without a storyboard, or after a failure. */
    val current: Tiles? get() = tiles

    suspend fun load(): Tiles? {
        if (asked) return tiles
        val t = try {
            source.storyboard(videoId)?.tiles?.takeIf { it.usable() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: java.io.IOException) {
            return null // (the next drag asks again)
        } catch (e: ApiException) {
            return null // asked again on the next drag (not remembered)
        }
        tiles = t
        asked = true
        return t
    }

    /** Sheet [n] decoded, or null when it can't be had (the preview then shows just the time). */
    suspend fun sheet(n: Int): B? {
        cache[n]?.let { return it }
        return try {
            decode(source.sheet(videoId, n))?.also { cache.put(n, it) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: java.io.IOException) {
            null
        } catch (e: ApiException) {
            null
        }
    }
}
