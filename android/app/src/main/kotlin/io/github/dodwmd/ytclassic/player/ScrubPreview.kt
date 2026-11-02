package io.github.dodwmd.ytclassic.player

import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.ByteBoundedLru
import io.github.dodwmd.ytclassic.data.Storyboard
import io.github.dodwmd.ytclassic.data.Tiles
import io.github.dodwmd.ytclassic.data.usable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.withContext

/** Where the previews come from: the server's descriptor (null when the video has no storyboard) and its sheets as image bytes. */
interface StoryboardSource {
    suspend fun storyboard(videoId: String): Storyboard?
    suspend fun sheet(videoId: String, n: Int): ByteArray
}

const val SHEET_CACHE_BYTES = 8L * 1024 * 1024

/**
 * Scrub previews for one video. The descriptor is asked for once (a video without a storyboard is remembered, a failed
 * request is tried again the next time); each sheet is fetched and decoded once, off the main thread, and kept in a
 * byte-bounded cache. A fetch belongs to this object, not to whoever asked: a caller that goes away (the drag moved on)
 * does not cancel it, and the next caller for the same sheet joins it. [B] is the decoded image (an ImageBitmap in the app);
 * [decode] gets the bytes and the descriptor and returns null for an image it can't or won't decode.
 */
class ScrubPreview<B : Any>(
    private val videoId: String,
    private val source: StoryboardSource,
    private val decode: (ByteArray, Tiles) -> B?,
    sizeOf: (B) -> Long,
    cacheBytes: Long = SHEET_CACHE_BYTES,
    private val decodeOn: CoroutineDispatcher = Dispatchers.Default,
) {
    private val cache = ByteBoundedLru<Int, B>(cacheBytes, sizeOf)
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val inflight = HashMap<Int, Deferred<B?>>()
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
        val t = tiles ?: return null
        if (n < 0 || n >= t.sheets) return null
        val job = synchronized(inflight) {
            inflight.getOrPut(n) {
                scope.async { try { fetch(n, t) } finally { synchronized(inflight) { inflight.remove(n) } } }
            }
        }
        return job.await()
    }

    /** Starts fetching sheet [n] in the background (the neighbour of the one being shown), if it is a sheet and not here yet. */
    fun prefetch(n: Int) {
        val t = tiles ?: return
        if (n in 0 until t.sheets && cache[n] == null) scope.async { sheet(n) }
    }

    /** Stops every fetch still running (the video is gone). */
    fun close() = scope.cancel()

    private suspend fun fetch(n: Int, t: Tiles): B? {
        val bytes = try {
            source.sheet(videoId, n)
        } catch (e: CancellationException) {
            throw e
        } catch (e: java.io.IOException) {
            return null
        } catch (e: ApiException) {
            return null
        }
        // Only the decode is guarded against failing: a corrupt or huge image is no preview, anything else stays loud.
        val image = withContext(decodeOn) {
            try {
                decode(bytes, t)
            } catch (e: CancellationException) {
                throw e
            } catch (e: OutOfMemoryError) {
                null
            } catch (e: RuntimeException) {
                null
            }
        }
        return image?.also { cache.put(n, it) }
    }
}
