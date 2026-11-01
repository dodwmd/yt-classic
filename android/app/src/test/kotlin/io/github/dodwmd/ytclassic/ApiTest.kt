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
    private var lastBody = ""
    private var tvReply: Pair<Int, String>? = null // overrides the TV answer
    private var importReply: Pair<Int, String>? = null // overrides the import and export answers for the error-path tests
    private lateinit var api: YtApi

    private fun fixture(name: String) = javaClass.getResource("/$name.json")!!.readText()

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            requests += "${ex.requestMethod} ${ex.requestURI}"
            val raw = ex.requestBody.readBytes()
            lastBody = raw.decodeToString()
            val path = ex.requestURI.path
            val (status, body) = when {
                path == "/healthz" -> 200 to "ok"
                path == "/api/status" -> 200 to fixture("status")
                path == "/api/home" -> 200 to fixture("home")
                path == "/api/search" -> 200 to fixture("search")
                path == "/api/video/dQw4w9WgXcQ" -> 200 to fixture("video")
                path == "/api/video/bad" -> 400 to """{"error":"bad video id"}"""
                path.startsWith("/api/channel/") -> 200 to fixture("channel")
                path == "/api/history" -> 200 to fixture("history")
                path == "/api/history/watched" -> 200 to fixture("watched")
                path == "/api/progress" -> 200 to """{"recorded":true}"""
                path == "/api/history/clear" -> 200 to """{"removed":2}"""
                path.startsWith("/api/history/") -> 200 to """{"removed":true}"""
                path == "/api/subscribe" -> 200 to """{"subscribed":true}"""
                path == "/api/unsubscribe" -> 200 to """{"subscribed":false}"""
                path == "/api/subscriptions/import" && ex.requestMethod == "POST" -> {
                    requests += "body=" + raw.joinToString(",") + " type=" + ex.requestHeaders.getFirst("Content-Type")
                    importReply ?: (200 to fixture("import"))
                }
                path == "/api/subscriptions/export" -> importReply ?: (200 to "Channel ID,Channel URL,Channel title\r\n")
                path == "/api/tv/next" -> tvReply ?: (200 to fixture("tv"))
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
    fun statusParsesRealResponseAndFormatsRows() = runBlocking {
        val s = api.status()
        assertEquals("ok", s.health)
        assertEquals("2026.10.26", s.ytdlp.version)
        assertEquals("bot-check", s.resolves.lastFailure?.reason)
        assertFalse(fixture("status").contains("videoId"), "the status response carries no video id")
        val rows = io.github.dodwmd.ytclassic.data.statusRows(s, nowMillis = java.time.Instant.parse("2026-11-01T14:25:00Z").toEpochMilli()).toMap()
        assertEquals("3 minutes ago", rows["Last successful resolve"])
        assertEquals("3 minutes ago · bot-check", rows["Last failure"])
        assertEquals("1 ok, 1 failed", rows["Resolves since start"])
        assertEquals("8.0.1", rows["ffmpeg"])
        val empty = io.github.dodwmd.ytclassic.data.statusRows(io.github.dodwmd.ytclassic.data.StatusResponse()).toMap()
        assertEquals("never", empty["Last failure"])
        assertEquals("not found", empty["yt-dlp"])
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
        assertEquals(io.github.dodwmd.ytclassic.data.ServerCheck.Ok, api.check())
        assertEquals(io.github.dodwmd.ytclassic.data.ServerCheck.Unreachable, YtApi(server = { "127.0.0.1:1" }).check())
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

    @Test
    fun homeAndVideoCarryResumeData() = runBlocking {
        val home = api.home()
        assertEquals("Half watched video", home.resume.single().title)
        assertEquals(0.4f, home.resume.single().fraction)
        val v = api.video("dQw4w9WgXcQ")
        assertEquals(240L, v.progress?.position)
        assertFalse(v.progress!!.completed)
    }

    @Test
    fun historyParsesRealResponse() = runBlocking {
        val page = api.history(before = "1793542868467.2")
        assertEquals("GET /api/history?limit=48&before=1793542868467.2", requests.last())
        assertEquals(2, page.items.size)
        assertTrue(page.items.first().completed)
        assertNull(page.items.first().fraction) // finished: no bar
        assertNull(page.next)
    }

    @Test
    fun watchedLookupSendsIdsAndReturnsASet() = runBlocking {
        assertEquals(setOf("aaaaaaaaaaa"), api.watched(listOf("aaaaaaaaaaa", "dQw4w9WgXcQ")))
        assertEquals("GET /api/history/watched?ids=aaaaaaaaaaa,dQw4w9WgXcQ".replace(",", "%2C"), requests.last())
    }

    @Test
    fun reportProgressPostsAFormWithOnlyIdPositionFinished() = runBlocking {
        api.reportProgress("dQw4w9WgXcQ", 42)
        assertEquals("POST /api/progress", requests.last())
        assertEquals("id=dQw4w9WgXcQ&position=42", lastBody)
        api.reportProgress("dQw4w9WgXcQ", 214, finished = true)
        assertEquals("id=dQw4w9WgXcQ&position=214&finished=1", lastBody)
    }

    @Test
    fun removeAndClearHistory() = runBlocking {
        api.removeFromHistory("dQw4w9WgXcQ")
        assertEquals("DELETE /api/history/dQw4w9WgXcQ", requests.last())
        api.clearHistory()
        assertEquals("POST /api/history/clear", requests.last())
    }

    @Test
    fun reportingToAnUnreachableServerThrowsApiExceptionForTheCallerToIgnore() {
        assertFailsWith<ApiException> { runBlocking { YtApi(server = { "127.0.0.1:1" }).reportProgress("dQw4w9WgXcQ", 10) } }
    }

    // The import fixture is hand-written in the backend's documented response shape (not a captured response).
    @Test
    fun importPostsTheRawBytesAndParsesTheSummary() = runBlocking {
        val bytes = byteArrayOf(0x43, 0xe9.toByte(), 0x0a) // not valid UTF-8: must arrive unchanged
        val r = api.importSubscriptions(bytes)
        assertEquals(7, r.added)
        assertEquals(3, r.skipped.handles)
        assertEquals("POST /api/subscriptions/import", requests.first { it.startsWith("POST") })
        assertEquals("body=67,-23,10 type=text/plain", requests.last())
    }

    @Test
    fun exportFetchesTheFormat() = runBlocking {
        assertEquals("Channel ID,Channel URL,Channel title\r\n", api.exportSubscriptions("csv"))
        assertEquals("GET /api/subscriptions/export?format=csv", requests.last())
    }

    @Test
    fun importErrorsCarryTheServersMessage() = runBlocking {
        importReply = 400 to """{"error":"No subscriptions found. Use a Google Takeout subscriptions.csv, an OPML file, or a list of channel URLs."}"""
        assertEquals("No subscriptions found. Use a Google Takeout subscriptions.csv, an OPML file, or a list of channel URLs.", assertFailsWith<ApiException> { api.importSubscriptions(ByteArray(1)) }.message)
        importReply = 413 to """{"error":"File too large (limit 1 MB)."}"""
        assertEquals("File too large (limit 1 MB).", assertFailsWith<ApiException> { api.importSubscriptions(ByteArray(1)) }.message)
        importReply = 400 to """{"error":"That file is not valid UTF-8 or UTF-16 text."}"""
        assertEquals("That file is not valid UTF-8 or UTF-16 text.", assertFailsWith<ApiException> { api.importSubscriptions(ByteArray(1)) }.message)
    }

    @Test
    fun importWithAProxyErrorOrJunkGivesAGenericMessage() = runBlocking {
        importReply = 502 to "<html>Bad Gateway</html>"
        assertEquals("Request failed (502)", assertFailsWith<ApiException> { api.importSubscriptions(ByteArray(1)) }.message)
        importReply = 200 to "<html>not json</html>"
        assertEquals("Unexpected response from the server.", assertFailsWith<ApiException> { api.importSubscriptions(ByteArray(1)) }.message)
    }

    @Test
    fun exportErrorsAreReportedNotWrittenAsFileContent() = runBlocking {
        importReply = 400 to """{"error":"format must be csv or opml"}"""
        assertEquals("format must be csv or opml", assertFailsWith<ApiException> { api.exportSubscriptions("zip") }.message)
        importReply = 502 to "<html>Bad Gateway</html>"
        assertEquals("Request failed (502)", assertFailsWith<ApiException> { api.exportSubscriptions("csv") }.message)
    }

    @Test
    fun importAndExportWhileOfflineSayTheServerCannotBeReached() = runBlocking {
        val port = server.address.port
        server.stop(0)
        val offline = YtApi(server = { "127.0.0.1:$port" })
        assertTrue(assertFailsWith<ApiException> { offline.importSubscriptions(ByteArray(1)) }.message!!.startsWith("Can't reach the server"))
        assertTrue(assertFailsWith<ApiException> { offline.exportSubscriptions("opml") }.message!!.startsWith("Can't reach the server"))
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).also { it.start() } // so @AfterTest has something to stop
    }

    @Test
    fun tvNextParsesRealResponseAndSendsAfterAndSeen() = runBlocking {
        val r = api.tvNext("UC0000000000000000000001", listOf("AAAAAAAAAAA", "BBBBBBBBBBB"))
        assertEquals("vid3x1zzzzz", r.video.id)
        assertEquals("UC0000000000000000000003", r.channelId)
        assertEquals(120, r.video.durationSeconds)
        assertEquals("GET /api/tv/next?after=UC0000000000000000000001&seen=AAAAAAAAAAA%2CBBBBBBBBBBB", requests.last())
        api.tvNext("", emptyList())
        assertEquals("GET /api/tv/next", requests.last(), "no after and no seen on the first request")
    }

    @Test
    fun tvNeedSubscriptionsIsATypedErrorWithTheServersMessage() {
        tvReply = 409 to fixture("tv-need")
        val e = assertFailsWith<io.github.dodwmd.ytclassic.data.NeedSubscriptionsException> { runBlocking { api.tvNext("", emptyList()) } }
        assertEquals("Subscribe to 1 more channel to turn on TV.", e.message)
        assertEquals(4, e.have)
        assertEquals(5, e.need)
    }

    @Test
    fun tvOtherErrorsStayPlainApiExceptions() {
        tvReply = 404 to """{"error":"Could not find anything playable right now.","code":"nothing-playable"}"""
        val e = assertFailsWith<ApiException> { runBlocking { api.tvNext("", emptyList()) } }
        assertEquals("Could not find anything playable right now.", e.message)
        assertFalse(e is io.github.dodwmd.ytclassic.data.NeedSubscriptionsException)
        tvReply = 409 to """{"error":"subscription limit reached"}"""
        assertFalse(assertFailsWith<ApiException> { runBlocking { api.tvNext("", emptyList()) } } is io.github.dodwmd.ytclassic.data.NeedSubscriptionsException)
    }
}
