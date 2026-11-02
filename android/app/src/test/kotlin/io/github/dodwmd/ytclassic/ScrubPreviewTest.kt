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
import io.github.dodwmd.ytclassic.data.usable
import io.github.dodwmd.ytclassic.player.ScrubPreview
import io.github.dodwmd.ytclassic.player.StoryboardSource
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
        for (bad in listOf(Tiles(), tiles.copy(count = 0), tiles.copy(interval = 0.0), tiles.copy(interval = Double.NaN), tiles.copy(cols = 0), tiles.copy(sheets = 0), tiles.copy(w = -1))) assertFalse(bad.usable(), bad.toString())
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
        val sheets = mutableListOf<Int>()
        override suspend fun storyboard(videoId: String): Storyboard? { boards++; if (fail) throw ApiException("down"); return board }
        override suspend fun sheet(videoId: String, n: Int): ByteArray { sheets += n; if (fail) throw java.io.IOException("down"); return ByteArray(10) { n.toByte() } }
    }

    private fun preview(src: FakeSource, bytes: Long = 1000) = ScrubPreview<ByteArray>("AAAAAAAAAAA", src, decode = { if (it.isEmpty()) null else it }, sizeOf = { it.size.toLong() }, cacheBytes = bytes)

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

    private lateinit var server: HttpServer
    private val seen = mutableListOf<String>()

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
                "/api/video/CCCCCCCCCCC/storyboard" -> Triple(401, "application/json", """{"error":"unauthorized"}""".toByteArray())
                else -> Triple(404, "application/json", res("storyboard-none.json").toByteArray())
            }
            ex.responseHeaders.add("Content-Type", type)
            ex.sendResponseHeaders(status, if (ex.requestURI.path.let { it.endsWith("/5.jpg") || it.endsWith("/6.jpg") }) 0 else body.size.toLong()) // 0 = chunked
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
    fun anOversizedSheetIsRefused() {
        assertFailsWith<ApiException> { runBlocking { api().storyboardSheet("AAAAAAAAAAA", 4) } }
    }

    @Test
    fun aSheetWithoutALengthIsReadWithinTheCap() {
        assertContentEquals(byteArrayOf(9, 8, 7), runBlocking { api().storyboardSheet("AAAAAAAAAAA", 5) })
        assertFailsWith<ApiException> { runBlocking { api().storyboardSheet("AAAAAAAAAAA", 6) } } // too big, and no length to tell us up front
    }
}
