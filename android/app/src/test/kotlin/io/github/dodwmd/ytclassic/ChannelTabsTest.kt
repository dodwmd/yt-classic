package io.github.dodwmd.ytclassic

import com.sun.net.httpserver.HttpServer
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.AuthException
import io.github.dodwmd.ytclassic.data.Chunk
import io.github.dodwmd.ytclassic.data.PageState
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.joinParts
import io.github.dodwmd.ytclassic.data.liveLabel
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val CH = "UCsBjURrPoezykLs9EqgamOA"

/** The channel tab calls, against responses captured from this repo's own backend with a stubbed Data API (src/test/resources/channel-*.json). */
class ChannelTabsTest {
    private lateinit var server: HttpServer
    private val requests = mutableListOf<String>()
    private val auth = mutableListOf<String?>()
    private var needToken = false
    private lateinit var api: YtApi

    private fun fixture(name: String) = javaClass.getResource("/$name.json")!!.readText()

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            requests += "${ex.requestMethod} ${ex.requestURI}"
            auth += ex.requestHeaders.getFirst("Authorization")
            val path = ex.requestURI.path
            val (status, body) = when {
                needToken && ex.requestHeaders.getFirst("Authorization") != "Bearer s3cret" -> 401 to """{"error":"unauthorized"}"""
                path == "/api/channel/$CH/playlists" -> 200 to fixture("channel-playlists")
                path.startsWith("/api/channel/$CH/playlist/PL") -> 200 to fixture("channel-playlist")
                path == "/api/channel/$CH/shorts" -> 200 to fixture("channel-shorts")
                path == "/api/channel/$CH/live" -> 200 to fixture("channel-live")
                path == "/api/channel/$CH/about" -> 200 to fixture("channel-about")
                path == "/api/channel/$CH/broken/x" -> 502 to """{"error":"Something went wrong talking to YouTube. Check the backend log."}"""
                else -> 404 to """{"error":"not found"}"""
            }
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        api = YtApi(server = { "127.0.0.1:${server.address.port}" }, token = { if (needToken) "s3cret" else "" })
    }

    @AfterTest
    fun stop() = server.stop(0)

    @Test
    fun playlistsParseAndCarryTheToken() = runBlocking {
        val p = api.channelPlaylists(CH, "P2")
        assertEquals("GET /api/channel/$CH/playlists?pageToken=P2", requests.last())
        assertEquals(3, p.items.size)
        assertEquals(4, p.items.first().itemCount)
        assertEquals("P2", p.nextPageToken)
        api.channelPlaylists(CH)
        assertEquals("GET /api/channel/$CH/playlists", requests.last())
    }

    @Test
    fun playlistDrillDownHasTitleAndVideos() = runBlocking {
        val r = api.channelPlaylist(CH, "PL11zzzzzzzzzzzzzz")
        assertEquals("100 Seconds of Code", r.playlist.title)
        assertEquals(2, r.page.items.size)
        assertTrue(r.page.items.all { it.id.length == 11 })
        assertEquals("I2", r.page.nextPageToken)
    }

    @Test
    fun shortsAndLiveParseWithLiveStates() = runBlocking {
        val shorts = api.channelTab(CH, "shorts")
        assertTrue(shorts.items.isNotEmpty() && shorts.items.all { (it.durationSeconds ?: 99) <= 61 && it.live == null })
        assertEquals("GET /api/channel/$CH/shorts", requests.last())
        val live = api.channelTab(CH, "live", "50")
        assertEquals("GET /api/channel/$CH/live?pageToken=50", requests.last())
        val states = live.items.associate { it.id to it.live }
        assertEquals("live", states["v0000000007"])
        assertEquals("upcoming", states["v0000000014"])
        assertEquals("ended", states["v0000000021"])
        assertEquals(listOf("Live now", "Upcoming", "Past stream", ""), listOf("live", "upcoming", "ended", null).map(::liveLabel))
        assertEquals("Live now · 2 days ago", joinParts(liveLabel("live"), "2 days ago"))
    }

    @Test
    fun aboutParsesAndKeepsOnlyWebLinks() = runBlocking {
        val a = api.channelAbout(CH)
        assertEquals("@Fireship", a.customUrl)
        assertEquals("2010-12-10T14:15:09Z", a.publishedAt)
        assertEquals("US", a.country)
        assertEquals("4320000", a.subscriberCount)
        assertEquals(listOf("https://fireship.io/", "https://github.com/fireship-io"), a.links)
    }

    @Test
    fun everyTabCallSendsTheBearerTokenAndSurfacesRejection() = runBlocking {
        needToken = true
        api.channelPlaylists(CH); api.channelPlaylist(CH, "PL11zzzzzzzzzzzzzz"); api.channelTab(CH, "shorts"); api.channelTab(CH, "live"); api.channelAbout(CH)
        assertEquals(5, auth.size)
        assertTrue(auth.all { it == "Bearer s3cret" })
        val wrong = YtApi(server = { "127.0.0.1:${server.address.port}" }, token = { "nope" })
        assertFailsWith<AuthException> { wrong.channelAbout(CH) }
        val none = YtApi(server = { "127.0.0.1:${server.address.port}" })
        assertFailsWith<AuthException> { none.channelTab(CH, "live") }
        Unit
    }

    @Test
    fun serverErrorsKeepTheirMessage() = runBlocking {
        val e = assertFailsWith<ApiException> { api.channelTab(CH, "broken/x") }
        assertEquals("Something went wrong talking to YouTube. Check the backend log.", e.message)
        Unit
    }

    // --- Paging rules ---

    private fun page(vararg ids: String, next: String? = null) = Chunk(ids.toList(), next)

    @Test
    fun firstPageThenMoreWithoutDuplicates() = runBlocking {
        val tokens = mutableListOf<String?>()
        val fetch: suspend (String?) -> Chunk<String> = { t ->
            tokens += t
            if (t == null) page("a", "b", next = "T2") else page("b", "c", next = null)
        }
        var s = PageState<String>()
        assertFalse(s.canLoadMore)
        s = s.begin().advance({ it }, fetch)
        assertEquals(listOf("a", "b"), s.items)
        assertTrue(s.canLoadMore)
        s = s.begin().advance({ it }, fetch)
        assertEquals(listOf("a", "b", "c"), s.items)
        assertFalse(s.canLoadMore)
        assertEquals(listOf(null, "T2"), tokens)
    }

    @Test
    fun failureKeepsItemsAndTokenSoRetryAsksForTheSamePage() = runBlocking {
        var fail = true
        val tokens = mutableListOf<String?>()
        val fetch: suspend (String?) -> Chunk<String> = { t ->
            tokens += t
            if (t != null && fail) throw ApiException("Can't reach the server") else if (t == null) page("a", next = "T2") else page("b")
        }
        var s = PageState<String>().begin().advance({ it }, fetch)
        s = s.begin().advance({ it }, fetch)
        assertEquals("Can't reach the server", s.error)
        assertEquals(listOf("a"), s.items)
        assertFalse(s.loading)
        fail = false
        s = s.begin().advance({ it }, fetch)
        assertNull(s.error)
        assertEquals(listOf("a", "b"), s.items)
        assertEquals(listOf(null, "T2", "T2"), tokens)
    }

    @Test
    fun aFailedFirstPageIsRetriedAsTheFirstPage() = runBlocking {
        var calls = 0
        val fetch: suspend (String?) -> Chunk<String> = { t ->
            assertNull(t)
            if (calls++ == 0) throw ApiException("boom") else page("a")
        }
        var s = PageState<String>().begin().advance({ it }, fetch)
        assertEquals("boom", s.error)
        assertFalse(s.started)
        s = s.begin().advance({ it }, fetch)
        assertEquals(listOf("a"), s.items)
        assertTrue(s.started)
    }

    @Test
    fun loadingBlocksLoadMoreAndEmptyIsStarted() {
        val s = PageState(listOf("a"), token = "T", started = true)
        assertTrue(s.canLoadMore)
        assertFalse(s.begin().canLoadMore)
        assertTrue(s.begin().loading)
        assertNull(s.begin().error)
    }
}
