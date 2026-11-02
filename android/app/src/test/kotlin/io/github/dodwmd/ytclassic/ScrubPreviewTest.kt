package io.github.dodwmd.ytclassic

import com.sun.net.httpserver.HttpServer
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.ApiJson
import io.github.dodwmd.ytclassic.data.AuthException
import io.github.dodwmd.ytclassic.data.ByteBoundedLru
import io.github.dodwmd.ytclassic.data.Storyboard
import io.github.dodwmd.ytclassic.data.TileRect
import io.github.dodwmd.ytclassic.data.Tiles
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.bubbleLeft
import io.github.dodwmd.ytclassic.data.locate
import io.github.dodwmd.ytclassic.data.sampleSizeFor
import io.github.dodwmd.ytclassic.data.usable
import io.github.dodwmd.ytclassic.player.ScrubPreview
import io.github.dodwmd.ytclassic.player.StoryboardSource
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

private fun res(name: String) = ScrubPreviewTest::class.java.getResource("/$name")!!.readText()

class ScrubPreviewTest {
    // The descriptor our backend returns for a 213 s video (see backend/src/yt/storyboard.test.ts): 320x180 tiles, 3x3 per sheet, 12 sheets.
    private val tiles = ApiJson.decodeFromString<Storyboard>(res("storyboard.json")).tiles

    @Test
    fun descriptorFromTheBackendParses() {
        assertEquals(Tiles(320, 180, 3, 3, 108, 1.972, 12), tiles)
        assertTrue(tiles.usable())
        for (bad in listOf(Tiles(), tiles.copy(count = 0), tiles.copy(interval = 0.0), tiles.copy(interval = Double.NaN), tiles.copy(cols = 0), tiles.copy(sheets = 0), tiles.copy(w = -1), tiles.copy(sheets = 2), tiles.copy(sheets = 13), tiles.copy(count = 109))) assertFalse(bad.usable(), bad.toString())
        assertFalse(ApiJson.decodeFromString<Storyboard>("{}").tiles.usable())
    }

    @Test
    fun timeMapsToSheetColumnAndRow() {
        assertEquals(TileRect(0, 0, 0, 320, 180), tiles.locate(0f))
        assertEquals(TileRect(0, 0, 0, 320, 180), tiles.locate(1.97f), "just before the second tile")
        assertEquals(TileRect(0, 320, 0, 320, 180), tiles.locate(1.98f))
        assertEquals(TileRect(0, 640, 0, 320, 180), tiles.locate(2 * 1.972f + 0.01f))
        assertEquals(TileRect(0, 0, 180, 320, 180), tiles.locate(3 * 1.972f + 0.01f), "next row")
        assertEquals(TileRect(1, 0, 0, 320, 180), tiles.locate(9 * 1.972f + 0.01f), "next sheet")
        assertEquals(TileRect(1, 640, 360, 320, 180), tiles.locate(17.8f * 1.972f))
        // 20 tiles per sheet, 45 in all: index 44 is the fifth tile of the third sheet.
        assertEquals(TileRect(2, 4 * 160, 0, 160, 90), Tiles(160, 90, 5, 4, 45, 2.0, 3).locate(88f))
    }

    @Test
    fun theEndAndOddTimesStayInsideTheStoryboard() {
        val last = TileRect(11, 640, 360, 320, 180) // 108 tiles: index 107, sheet 11, tile 8
        assertEquals(last, tiles.locate(213f))
        assertEquals(last, tiles.locate(99_999f))
        assertEquals(last, tiles.locate(Float.POSITIVE_INFINITY))
        assertEquals(tiles.locate(0f), tiles.locate(-5f))
        assertEquals(tiles.locate(0f), tiles.locate(Float.NaN))
        assertEquals(TileRect(0, 0, 0, 640, 360), Tiles(640, 360, 1, 1, 1, 300.0, 1).locate(250f), "a single tile")
        for (s in 0..2200) assertTrue(tiles.locate(s / 10f).sheet in 0 until tiles.sheets)
    }

    @Test
    fun bubbleStaysInTheWindowAndCentresOnTheThumb() {
        // slider at x=100, 800 px wide, 4 px inset each side, bubble 320 px, window 1080 px
        assertEquals(100 + 4 + 396 - 160, bubbleLeft(100, 800, 4, 0.5f, 320, 1080))
        assertEquals(0, bubbleLeft(100, 800, 4, 0f, 320, 1080), "left edge")
        assertEquals(100 + 4 + 792 - 160, bubbleLeft(100, 800, 4, 1f, 320, 1080), "end of the track")
        assertEquals(100 + 4 + 792 - 160, bubbleLeft(100, 800, 4, 7f, 320, 1080), "out-of-range fractions are clamped")
        assertEquals(1080 - 320, bubbleLeft(500, 800, 4, 1f, 320, 1080), "pushed back inside the window")
        assertEquals(0, bubbleLeft(0, 100, 4, 0.5f, 320, 200), "a window narrower than the bubble")
        assertEquals(0, bubbleLeft(0, 2, 4, 0.5f, 10, 100), "a slider narrower than its insets")
    }

    @Test
    fun lruIsBoundedByBytesAndEvictsTheOldestUsed() {
        val c = ByteBoundedLru<Int, ByteArray>(100) { it.size.toLong() }
        c.put(1, ByteArray(40))
        c.put(2, ByteArray(40))
        c[1] // 1 is now the most recently used
        c.put(3, ByteArray(40))
        assertNull(c[2], "the least recently used went")
        assertTrue(c[1] != null && c[3] != null)
        assertEquals(80, c.bytes)
        c.put(4, ByteArray(101))
        assertNull(c[4], "bigger than the bound: not kept")
        assertEquals(80, c.bytes)
        c.put(1, ByteArray(10))
        assertEquals(50, c.bytes, "replacing a key frees its old size")
        assertEquals(2, c.size)
    }

    private class FakeSource(var board: Storyboard? = null, var fail: Boolean = false) : StoryboardSource {
        var boards = 0
        val sheets = java.util.concurrent.CopyOnWriteArrayList<Int>()
        override suspend fun storyboard(videoId: String): Storyboard? { boards++; if (fail) throw ApiException("down"); return board }
        override suspend fun sheet(videoId: String, n: Int): ByteArray { sheets += n; if (fail) throw java.io.IOException("down"); return ByteArray(10) { n.toByte() } }
    }

    private fun preview(src: FakeSource, bytes: Long = 1000, decode: (ByteArray, Tiles) -> ByteArray? = { b, _ -> if (b.isEmpty()) null else b }) =
        ScrubPreview("AAAAAAAAAAA", src, decode = decode, sizeOf = { it.size.toLong() }, cacheBytes = bytes)

    @Test
    fun descriptorIsAskedOnceAndMissingStoryboardsAreRemembered() = runBlocking {
        val src = FakeSource(Storyboard(tiles, 213.0))
        val p = preview(src)
        assertNull(p.current)
        assertEquals(tiles, p.load())
        assertEquals(tiles, p.load())
        assertEquals(tiles, p.current)
        assertEquals(1, src.boards)
        val none = FakeSource(null)
        val q = preview(none)
        assertNull(q.load())
        assertNull(q.load())
        assertEquals(1, none.boards, "no storyboard: not asked again")
        val broken = FakeSource(Storyboard(tiles.copy(count = 0), 1.0))
        assertNull(preview(broken).load(), "an unusable descriptor means no previews")
    }

    @Test
    fun aFailedDescriptorIsRetriedOnTheNextDrag() = runBlocking {
        val src = FakeSource(Storyboard(tiles, 213.0), fail = true)
        val p = preview(src)
        assertNull(p.load())
        src.fail = false
        assertEquals(tiles, p.load())
        assertEquals(2, src.boards)
    }

    @Test
    fun sheetsAreFetchedOnceAndKeptWithinTheByteBound() = runBlocking {
        val src = FakeSource(Storyboard(tiles, 213.0))
        val p = preview(src, bytes = 25) // two 10-byte sheets fit
        p.load()
        val a = p.sheet(0)!!
        assertSame(a, p.sheet(0))
        p.sheet(1)
        p.sheet(2)
        assertEquals(listOf(0, 1, 2), src.sheets)
        p.sheet(0)
        assertEquals(listOf(0, 1, 2, 0), src.sheets, "sheet 0 was evicted by the bound")
        src.fail = true
        assertNull(p.sheet(5), "a failing sheet is no preview, not a crash")
    }

    @Test
    fun sheetsAreDecodedOffTheCallersThread() = runBlocking {
        val src = FakeSource(Storyboard(tiles, 213.0))
        val threads = java.util.concurrent.CopyOnWriteArrayList<Thread>()
        val p = preview(src, decode = { b, _ -> threads += Thread.currentThread(); b })
        p.load()
        p.sheet(0)
        assertEquals(1, threads.size)
        assertTrue(threads[0] !== Thread.currentThread(), "decoding runs on a worker thread")
    }

    @Test
    fun aDecoderThatFailsOrRefusesIsNoPreviewNotACrash() = runBlocking {
        val src = FakeSource(Storyboard(tiles, 213.0))
        for (decode in listOf<(ByteArray, Tiles) -> ByteArray?>({ _, _ -> null }, { _, _ -> throw IllegalArgumentException("bad image") }, { _, _ -> throw OutOfMemoryError() })) {
            val p = preview(src, decode = decode)
            p.load()
            assertNull(p.sheet(1))
        }
        val big = preview(src)
        big.load()
        assertEquals(10, big.sheet(2)?.size, "the same source still decodes with a working decoder")
    }

    @Test
    fun anOutOfRangeOrUnloadedSheetIsNull() = runBlocking {
        val src = FakeSource(Storyboard(tiles, 213.0))
        val p = preview(src)
        assertNull(p.sheet(0), "before the descriptor is loaded")
        p.load()
        assertNull(p.sheet(12))
        assertNull(p.sheet(-1))
        assertTrue(src.sheets.isEmpty())
    }

    @Test
    fun aCallerThatLeavesDoesNotCancelTheFetchAndTheNextOneJoinsIt() = runBlocking {
        val gate = kotlinx.coroutines.CompletableDeferred<Unit>()
        val src = object : StoryboardSource {
            val calls = java.util.concurrent.atomic.AtomicInteger()
            override suspend fun storyboard(videoId: String) = Storyboard(tiles, 213.0)
            override suspend fun sheet(videoId: String, n: Int): ByteArray { calls.incrementAndGet(); gate.await(); return ByteArray(10) }
        }
        val p = ScrubPreview<ByteArray>("AAAAAAAAAAA", src, decode = { b, _ -> b }, sizeOf = { it.size.toLong() })
        p.load()
        val first = async(kotlinx.coroutines.Dispatchers.Default) { p.sheet(3) }
        while (src.calls.get() == 0) kotlinx.coroutines.delay(5)
        first.cancel() // the drag moved on
        assertFailsWith<kotlinx.coroutines.CancellationException> { first.await() }
        val second = async(kotlinx.coroutines.Dispatchers.Default) { p.sheet(3) }
        gate.complete(Unit)
        assertEquals(10, second.await()?.size)
        assertEquals(1, src.calls.get(), "one download for both callers")
        p.close()
    }

    @Test
    fun closingStopsFetchesAndPrefetchWarmsTheNeighbour() = runBlocking {
        val src = FakeSource(Storyboard(tiles, 213.0))
        val p = preview(src)
        p.load()
        p.prefetch(4)
        p.prefetch(99) // not a sheet: ignored
        val t0 = System.currentTimeMillis()
        while (src.sheets.isEmpty() && System.currentTimeMillis() - t0 < 5000) kotlinx.coroutines.delay(10)
        assertEquals(listOf(4), src.sheets.toList())
        assertEquals(10, p.sheet(4)?.size)
        assertEquals(listOf(4), src.sheets.toList(), "the prefetched sheet is served from the cache")
        p.close()
    }

    @Test
    fun sampleSizeRefusesHugeSheetsAndShrinksBigOnes() {
        assertEquals(1, sampleSizeFor(960, 540, 320))
        assertNull(sampleSizeFor(5000, 100, 320), "a side over 4096")
        assertNull(sampleSizeFor(0, 100, 320))
        assertNull(sampleSizeFor(100, 100, 0))
        // 4096x4096 RGB_565 is 32 MB: shrunk until it is within 8 MB
        assertEquals(2, sampleSizeFor(4096, 4096, 640, minTileWidth = 10_000))
        assertEquals(1, sampleSizeFor(4096, 1024, 640, minTileWidth = 10_000), "4096x1024 at 2 bytes is exactly 8 MB")
        assertNull(sampleSizeFor(4096, 4096, 1, minTileWidth = 10_000), "a tile that could not survive the shrinking")
        // oversized tiles are also sampled for display: 1280-px tiles with a 320-px floor
        assertEquals(4, sampleSizeFor(3840, 2160, 1280))
        assertEquals(1, sampleSizeFor(960, 540, 320), "never below the floor")
    }

    private lateinit var server: HttpServer
    private val seen = java.util.concurrent.CopyOnWriteArrayList<String>()

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            seen += ex.requestURI.path + " auth=" + ex.requestHeaders.getFirst("Authorization")
            val (status, type, body) = when (ex.requestURI.path) {
                "/api/video/AAAAAAAAAAA/storyboard" -> Triple(200, "application/json", res("storyboard.json").toByteArray())
                "/api/video/AAAAAAAAAAA/storyboard/3.jpg" -> Triple(200, "image/jpeg", byteArrayOf(-1, -40, -1, 0, 1, 2, 3))
                "/api/video/AAAAAAAAAAA/storyboard/5.jpg" -> Triple(200, "image/jpeg", byteArrayOf(9, 8, 7))
                "/api/video/AAAAAAAAAAA/storyboard/6.jpg" -> Triple(200, "image/jpeg", ByteArray(2 * 1024 * 1024 + 1))
                "/api/video/AAAAAAAAAAA/storyboard/4.jpg" -> Triple(200, "image/jpeg", ByteArray(2 * 1024 * 1024 + 1))
                "/api/video/AAAAAAAAAAA/storyboard/7.jpg" -> Triple(401, "application/json", """{"error":"unauthorized"}""".toByteArray())
                "/api/video/AAAAAAAAAAA/storyboard/8.jpg" -> Triple(200, "image/jpeg", java.io.ByteArrayOutputStream().also { o -> java.util.zip.GZIPOutputStream(o).use { it.write(byteArrayOf(5, 4, 3, 2)) } }.toByteArray())
                "/api/video/CCCCCCCCCCC/storyboard" -> Triple(401, "application/json", """{"error":"unauthorized"}""".toByteArray())
                else -> Triple(404, "application/json", res("storyboard-none.json").toByteArray())
            }
            ex.responseHeaders.add("Content-Type", type)
            if (ex.requestURI.path.endsWith("/8.jpg")) ex.responseHeaders.add("Content-Encoding", "gzip")
            ex.sendResponseHeaders(status, if (ex.requestURI.path.let { it.endsWith("/5.jpg") || it.endsWith("/6.jpg") || it.endsWith("/8.jpg") }) 0 else body.size.toLong()) // 0 = chunked
            ex.responseBody.use { it.write(body) }
        }
        server.start()
    }

    @AfterTest
    fun stop() = server.stop(0)

    private fun api(token: String = "") = YtApi(server = { "127.0.0.1:${server.address.port}" }, token = { token })

    @Test
    fun apiFetchesTheDescriptorAndSheetsWithTheToken() = runBlocking {
        val a = api("secret-token")
        assertEquals(tiles, a.storyboard("AAAAAAAAAAA")?.tiles)
        assertContentEquals(byteArrayOf(-1, -40, -1, 0, 1, 2, 3), a.storyboardSheet("AAAAAAAAAAA", 3))
        assertEquals(2, seen.size)
        assertTrue(seen.all { it.endsWith("auth=Bearer secret-token") }, seen.toString())
    }

    @Test
    fun noStoryboardIsNullAndOtherFailuresAreErrors() {
        assertNull(runBlocking { api().storyboard("BBBBBBBBBBB") })
        val e = assertFailsWith<ApiException> { runBlocking { api().storyboardSheet("BBBBBBBBBBB", 0) } }
        assertEquals("no-storyboard", e.code)
        assertFailsWith<AuthException> { runBlocking { api().storyboard("CCCCCCCCCCC") } }
    }

    @Test
    fun aRejectedTokenOnTheSheetPathIsAnAuthException() {
        assertFailsWith<AuthException> { runBlocking { api("wrong").storyboardSheet("AAAAAAAAAAA", 7) } }
    }

    @Test
    fun aGzippedSheetWithoutALengthIsDecodedAndBounded() {
        assertContentEquals(byteArrayOf(5, 4, 3, 2), runBlocking { api().storyboardSheet("AAAAAAAAAAA", 8) })
    }

    @Test
    fun anOversizedSheetIsRefused() {
        assertFailsWith<ApiException> { runBlocking { api().storyboardSheet("AAAAAAAAAAA", 4) } }
    }

    @Test
    fun aSheetWithoutALengthIsReadWithinTheCap() {
        assertContentEquals(byteArrayOf(9, 8, 7), runBlocking { api().storyboardSheet("AAAAAAAAAAA", 5) })
        assertFailsWith<ApiException> { runBlocking { api().storyboardSheet("AAAAAAAAAAA", 6) } } // too big, and no length to tell us up front
    }
}
