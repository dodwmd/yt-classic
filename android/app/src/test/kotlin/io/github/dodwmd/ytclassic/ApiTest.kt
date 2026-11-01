package io.github.dodwmd.ytclassic

import com.sun.net.httpserver.HttpServer
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.normalizeServerUrl
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Talks to a tiny local server that replays real responses captured from the backend (src/test/resources). */
class ApiTest {
    private lateinit var server: HttpServer
    private val requests = mutableListOf<String>()
    private lateinit var api: YtApi

    private fun fixture(name: String) = javaClass.getResource("/$name.json")!!.readText()

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            requests += "${ex.requestMethod} ${ex.requestURI}"
            val path = ex.requestURI.path
            val (status, body) = when {
                path == "/healthz" -> 200 to "ok"
                path == "/api/home" -> 200 to fixture("home")
                path == "/api/search" -> 200 to fixture("search")
                path == "/api/video/dQw4w9WgXcQ" -> 200 to fixture("video")
                path == "/api/video/bad" -> 400 to """{"error":"bad video id"}"""
                path.startsWith("/api/channel/") -> 200 to fixture("channel")
                path == "/api/subscribe" -> 200 to """{"subscribed":true}"""
                path == "/api/unsubscribe" -> 200 to """{"subscribed":false}"""
                path == "/api/html" -> 200 to "<html>not json</html>"
                else -> 404 to """{"error":"not found"}"""
            }
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        api = YtApi(server = { "127.0.0.1:${server.address.port}" })
    }

    @AfterTest
    fun stop() = server.stop(0)

    @Test
    fun homeParsesRealResponse() = runBlocking {
        val home = api.home()
        assertEquals("Fireship", home.subs.single().title)
        assertTrue(home.feed.isNotEmpty())
        assertNull(home.feed.first().views) // fallback feed items have no view count
    }

    @Test
    fun searchParsesRealResponse() = runBlocking {
        val page = api.search("nixos")
        assertEquals(3, page.items.size)
        assertNotNull(page.items.first().durationSeconds)
        assertEquals("", page.items.first().publishedAt) // yt-dlp search results carry no date
        assertEquals("GET /api/search?q=nixos", requests.last())
    }

    @Test
    fun searchPassesPageToken() = runBlocking {
        api.search("nixos", pageToken = "2")
        assertEquals("GET /api/search?q=nixos&pageToken=2", requests.last())
    }

    @Test
    fun videoParsesRealResponse() = runBlocking {
        val v = api.video("dQw4w9WgXcQ")
        assertEquals("dQw4w9WgXcQ", v.video.id)
        assertEquals(214, v.video.durationSeconds)
        assertEquals(listOf(360, 480, 720, 1080), v.qualities)
        assertTrue(v.related.items.isNotEmpty())
        assertNull(v.related.items.first().publishedAt)
    }

    @Test
    fun channelParsesRealResponse() = runBlocking {
        val c = api.channel("UCsBjURrPoezykLs9EqgamOA")
        assertEquals("Fireship", c.channel.title)
        assertFalse(c.subscribed)
        assertTrue(c.page.items.isNotEmpty())
    }

    @Test
    fun subscribeAndUnsubscribePostTheChannelId() = runBlocking {
        assertTrue(api.setSubscribed("UCx", true))
        assertEquals("POST /api/subscribe", requests.last())
        assertFalse(api.setSubscribed("UCx", false))
    }

    @Test
    fun serverErrorMessageIsSurfaced() {
        val e = assertFailsWith<ApiException> { runBlocking { api.video("bad") } }
        assertEquals("bad video id", e.message)
    }

    @Test
    fun errorWithoutJsonFallsBackToStatus() {
        val e = assertFailsWith<ApiException> { runBlocking { YtApi(server = { "127.0.0.1:${server.address.port}/nope" }).home() } }
        assertEquals("not found", e.message)
    }

    @Test
    fun nonJsonBodyIsReportedAsUnexpected() {
        // /api/html returns 200 with HTML: must not crash with a raw parser exception.
        val e = assertFailsWith<ApiException> { runBlocking { YtApi(server = { "127.0.0.1:${server.address.port}" }).let { it.search("x").let { _ -> it.video("html") } } } }
        assertTrue(e.message!!.isNotBlank())
    }

    @Test
    fun unreachableServerGivesAReadableError() {
        val e = assertFailsWith<ApiException> { runBlocking { YtApi(server = { "127.0.0.1:1" }).home() } }
        assertTrue(e.message!!.startsWith("Can't reach the server"), e.message)
    }

    @Test
    fun blankServerAsksForSettings() {
        val e = assertFailsWith<ApiException> { runBlocking { YtApi(server = { "  " }).home() } }
        assertTrue(e.message!!.contains("Settings"))
    }

    @Test
    fun pingReportsHealth() = runBlocking {
        assertTrue(api.ping())
        assertFalse(YtApi(server = { "127.0.0.1:1" }).ping())
    }

    @Test
    fun streamUrlCarriesQualityLanguageAndStart() = runBlocking {
        assertEquals("http://127.0.0.1:8080/stream/abc?q=720", YtApi(server = { "127.0.0.1:8080" }).streamUrl("abc", 720))
        assertEquals(
            "http://host:8080/stream/abc?q=1080&a=pt&t=90",
            YtApi(server = { "http://host:8080/" }).streamUrl("abc", 1080, startSeconds = 90, lang = "pt"),
        )
    }

    @Test
    fun serverUrlNormalization() {
        assertEquals("http://192.168.1.5:8080/", normalizeServerUrl("192.168.1.5:8080")?.toString())
        assertEquals("https://yt.example.com/", normalizeServerUrl(" https://yt.example.com/ ")?.toString())
        assertNull(normalizeServerUrl(""))
        assertNull(normalizeServerUrl("http://"))
    }
}
