package io.github.dodwmd.ytclassic

import com.sun.net.httpserver.HttpServer
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.AuthException
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.ui.LaterState
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Replays real backend output (src/test/resources/playlist*.json, membership.json) from a tiny local server. */
class PlaylistsTest {
    private lateinit var server: HttpServer
    private val requests = mutableListOf<String>()
    private val auth = mutableListOf<String?>()
    private val bodies = mutableListOf<String>()
    private val posts = AtomicInteger()
    private var reply: Pair<Int, String>? = null // overrides every answer (error paths)
    private var slow = false
    private var token = ""
    private val api get() = YtApi(server = { "127.0.0.1:${server.address.port}" }, token = { token })

    private fun fixture(name: String) = javaClass.getResource("/$name.json")!!.readText()

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            requests += "${ex.requestMethod} ${ex.requestURI}"
            auth += ex.requestHeaders.getFirst("Authorization")
            bodies += ex.requestBody.readBytes().decodeToString()
            if (ex.requestMethod == "POST") posts.incrementAndGet()
            if (slow) Thread.sleep(300)
            val path = ex.requestURI.path
            val (status, body) = reply ?: when {
                path == "/api/playlists/membership" -> 200 to fixture("membership")
                path == "/api/playlists" && ex.requestMethod == "GET" -> 200 to fixture("playlists")
                path == "/api/playlists" -> 200 to fixture("playlist-created")
                path == "/api/playlists/1" -> 200 to fixture("playlist")
                path.endsWith("/rename") -> 200 to """{"playlist":{"id":2,"name":"Tunes","count":0,"builtin":false}}"""
                path.endsWith("/items") -> 200 to """{"added":true,"playlist":{"id":1,"name":"Watch later","count":6,"builtin":true}}"""
                path.endsWith("/move") -> 200 to """{"moved":true}"""
                path.startsWith("/api/playlists/") && ex.requestMethod == "DELETE" -> 200 to """{"removed":true}"""
                else -> 404 to """{"error":"not found"}"""
            }
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @AfterTest
    fun stop() = server.stop(0)

    @Test
    fun parsesPlaylistsPageAndMembership() = runBlocking {
        val lists = api.playlists()
        assertEquals(listOf("Watch later", "Music", "Talks"), lists.map { it.name })
        assertTrue(lists[0].builtin)
        assertFalse(lists[1].builtin)
        assertEquals(5, lists[0].count)

        val page = api.playlist(1)
        assertEquals("1.2", page.next)
        assertEquals(2, page.items.size)
        assertEquals("How a bicycle works", page.items[0].title)
        assertEquals(120, page.items[0].durationSeconds)
        api.playlist(1, page.next)
        assertEquals("GET /api/playlists/1?limit=48&before=1.2", requests.last())

        assertEquals(setOf("dQw4w9WgXc0"), api.inWatchLater(listOf("dQw4w9WgXc0", "dQw4w9WgXc9")))
        assertEquals("GET /api/playlists/membership?ids=dQw4w9WgXc0%2CdQw4w9WgXc9", requests.last().replace(",", "%2C"))
    }

    @Test
    fun writesUseTheRightRoutesAndBodies() = runBlocking {
        assertEquals("Fresh", api.createPlaylist("Fresh").name)
        assertEquals("POST /api/playlists", requests.last())
        assertEquals("name=Fresh", bodies.last())
        assertEquals("Tunes", api.renamePlaylist(2, "Tunes").name)
        assertEquals("POST /api/playlists/2/rename", requests.last())
        assertTrue(api.addToPlaylist(1, "dQw4w9WgXc0"))
        assertEquals("POST /api/playlists/1/items", requests.last())
        assertEquals("id=dQw4w9WgXc0", bodies.last())
        api.moveToTop(1, "dQw4w9WgXc1")
        assertEquals("POST /api/playlists/1/move", requests.last())
        assertEquals("id=dQw4w9WgXc1&index=0", bodies.last())
        api.removeFromPlaylist(1, "dQw4w9WgXc0")
        assertEquals("DELETE /api/playlists/1/items/dQw4w9WgXc0", requests.last())
        api.deletePlaylist(2)
        assertEquals("DELETE /api/playlists/2", requests.last())
    }

    @Test
    fun serverMessagesReachTheUser() = runBlocking {
        reply = 409 to """{"error":"A playlist with that name already exists."}"""
        assertEquals("A playlist with that name already exists.", assertFailsWith<ApiException> { api.createPlaylist("Music") }.message)
        reply = 403 to """{"error":"Watch later cannot be renamed or deleted."}"""
        assertEquals("Watch later cannot be renamed or deleted.", assertFailsWith<ApiException> { api.deletePlaylist(1) }.message)
        assertFailsWith<ApiException> { api.renamePlaylist(1, "x") }
        reply = 404 to """{"error":"video not found"}"""
        assertEquals("video not found", assertFailsWith<ApiException> { api.addToPlaylist(1, "dQw4w9WgXc0") }.message)
        Unit
    }

    @Test
    fun everyCallCarriesTheToken() = runBlocking {
        token = "secret-not-real"
        api.playlists()
        api.createPlaylist("x")
        api.removeFromPlaylist(1, "dQw4w9WgXc0")
        api.moveToTop(1, "dQw4w9WgXc0")
        api.inWatchLater(listOf("dQw4w9WgXc0"))
        assertTrue(auth.isNotEmpty() && auth.all { it == "Bearer secret-not-real" }, auth.toString())
        token = ""
        reply = 401 to """{"error":"unauthorized"}"""
        assertFailsWith<AuthException> { api.addToPlaylist(1, "dQw4w9WgXc0") }
        Unit
    }

    @Test
    fun laterToggleAddsRemovesAndIgnoresTapsWhileInFlight() = runBlocking {
        val job = Job()
        val later = LaterState(api, CoroutineScope(job + Dispatchers.IO))
        slow = true
        later.toggle("dQw4w9WgXc0")
        later.toggle("dQw4w9WgXc0") // a second tap while the first is still running
        waitUntil { later.busy.isEmpty() }
        assertEquals(1, posts.get(), "one request for two taps")
        assertEquals(setOf("dQw4w9WgXc0"), later.members)
        later.toggle("dQw4w9WgXc0")
        waitUntil { later.busy.isEmpty() }
        assertEquals("DELETE /api/playlists/1/items/dQw4w9WgXc0", requests.last())
        assertTrue(later.members.isEmpty())
        job.cancel()
    }

    @Test
    fun laterFailureStaysNextToTheVideoAndClearsOnSuccess() = runBlocking {
        val job = Job()
        val later = LaterState(api, CoroutineScope(job + Dispatchers.IO))
        reply = 409 to """{"error":"Limit reached."}"""
        later.toggle("dQw4w9WgXc0")
        waitUntil { later.busy.isEmpty() }
        assertEquals("Limit reached.", later.errors["dQw4w9WgXc0"])
        assertTrue(later.members.isEmpty(), "a failed add must not show a check mark")
        assertNull(later.errors["other"])
        reply = null
        later.toggle("dQw4w9WgXc0")
        waitUntil { later.busy.isEmpty() }
        assertTrue(later.errors.isEmpty())
        assertEquals(setOf("dQw4w9WgXc0"), later.members)
        job.cancel()
    }

    private suspend fun waitUntil(cond: () -> Boolean) {
        repeat(200) { if (!cond()) delay(25) }
        assertTrue(cond(), "timed out")
        delay(20)
    }
}
