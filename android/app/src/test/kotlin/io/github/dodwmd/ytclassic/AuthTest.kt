package io.github.dodwmd.ytclassic

import com.sun.net.httpserver.HttpServer
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.AuthException
import io.github.dodwmd.ytclassic.data.ServerCheck
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.player.authorizationFor
import io.github.dodwmd.ytclassic.player.origin
import io.github.dodwmd.ytclassic.player.streamClient
import io.github.dodwmd.ytclassic.player.streamRequest
import okhttp3.OkHttpClient
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

/** A backend started with ACCESS_TOKEN: everything except /healthz and /api/session wants `Authorization: Bearer`. */
class AuthTest {
    private val secret = "test-secret-not-real"
    private lateinit var server: HttpServer
    private val seenAuth = mutableListOf<String?>()
    private val seenUrls = mutableListOf<String>()
    private var required = true
    private var sessionReply: Pair<Int, String>? = null // overrides /api/session

    private fun api(token: String) = YtApi(server = { "127.0.0.1:${server.address.port}" }, token = { token })

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            val auth = ex.requestHeaders.getFirst("Authorization")
            seenAuth += auth
            seenUrls += ex.requestURI.toString()
            val path = ex.requestURI.path
            val ok = auth == "Bearer $secret"
            val (status, body) = when {
                path == "/healthz" -> 200 to "ok"
                path == "/api/session" && sessionReply != null -> sessionReply!!
                path == "/api/session" ->
                    if (auth != null && auth != "Bearer $secret" && seenAuth.size > 50) 429 to """{"error":"too many attempts"}"""
                    else 200 to """{"auth":"${if (required) "required" else "none"}","authenticated":${ok || !required}}"""
                required && !ok -> 401 to """{"error":"unauthorized"}"""
                path == "/api/subscribe" -> 200 to """{"subscribed":true}"""
                path == "/api/home" -> 200 to javaClass.getResource("/home.json")!!.readText()
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
    fun bearerIsSentOnGetsAndPosts() = runBlocking {
        val a = api(secret)
        a.home()
        assertTrue(a.setSubscribed("UCx", true))
        assertEquals(listOf<String?>("Bearer $secret", "Bearer $secret"), seenAuth)
    }

    @Test
    fun missingTokenIsADistinctClearError() {
        val e = assertFailsWith<AuthException> { runBlocking { api("").home() } }
        assertFalse(e.tokenSet)
        assertEquals("Server needs an access token: set it in Settings.", e.message)
        assertNull(seenAuth.last(), "no Authorization header without a token")
    }

    @Test
    fun wrongTokenIsReportedAsRejected() {
        val e = assertFailsWith<ApiException> { runBlocking { api("nope").home() } }
        assertTrue(e is AuthException && e.tokenSet)
        assertTrue(e.message!!.contains("rejected"))
        assertFalse(e.message!!.contains("nope"), "the token never appears in an error message")
    }

    @Test
    fun connectionTestDistinguishesTheCases() = runBlocking {
        assertEquals(ServerCheck.Ok, api(secret).check())
        assertEquals(ServerCheck.NeedsToken, api("").check())
        assertEquals(ServerCheck.TokenRejected, api("wrong").check())
        assertEquals(ServerCheck.Unreachable, YtApi(server = { "127.0.0.1:1" }, token = { secret }).check())
        required = false
        assertEquals(ServerCheck.Ok, api("").check(), "an open server needs no token")
        assertTrue(ServerCheck.NeedsToken.message != ServerCheck.TokenRejected.message)
    }

    @Test
    fun tokenNeverGoesIntoAUrl() = runBlocking {
        val a = api(secret)
        a.home()
        a.check()
        assertFalse(a.streamUrl("abcdefghijk", 720).contains(secret))
        assertTrue(seenUrls.none { it.contains(secret) })
        assertEquals("Bearer $secret", a.streamAuthorization())
        assertNull(api("  ").streamAuthorization())
    }

    @Test
    fun tokenIsOnlyAttachedForTheStreamOrigin() {
        val stream = origin("http://192.168.1.5:8080/stream/x?q=720")
        assertEquals("http://192.168.1.5:8080", stream)
        assertEquals("https://yt.example.com:443", origin("https://yt.example.com/stream/x"))
        assertTrue(stream != origin("https://i.ytimg.com/vi/x/mq.jpg"))
        assertTrue(stream != origin("http://192.168.1.5:9090/stream/x"))
        assertNull(origin("not a url"))
    }

    @Test
    fun checkNeverSaysConnectedForOddSessionResponses() = runBlocking {
        sessionReply = 429 to """{"error":"too many attempts"}"""
        assertEquals(ServerCheck.TooManyAttempts, api(secret).check())
        sessionReply = 401 to """{"error":"unauthorized"}"""
        assertEquals(ServerCheck.NeedsToken, api("").check())
        assertEquals(ServerCheck.TokenRejected, api("x").check())
        sessionReply = 500 to "boom"
        assertEquals(ServerCheck.Unexpected, api(secret).check())
        sessionReply = 200 to "<html>a captive portal</html>"
        assertEquals(ServerCheck.Unexpected, api(secret).check())
        sessionReply = 200 to """{"hello":"world"}"""
        assertEquals(ServerCheck.Unexpected, api(secret).check())
        sessionReply = 200 to """{"auth":"weird","authenticated":true}"""
        assertEquals(ServerCheck.Unexpected, api(secret).check())
        sessionReply = 404 to """{"error":"not found"}"""
        assertEquals(ServerCheck.Ok, api("").check(), "a server that predates the token is open")
        sessionReply = 200 to """{"auth":"none","authenticated":true}"""
        assertEquals(ServerCheck.Ok, api("").check())
        assertTrue(ServerCheck.entries.map { it.message }.toSet().size == ServerCheck.entries.size, "every outcome has its own message")
    }

    @Test
    fun authorizationOnlyForTheExactStreamOrigin() {
        val o = origin("http://192.168.1.5:8080/stream/x")
        val a = "Bearer t"
        assertEquals(a, authorizationFor("http://192.168.1.5:8080/stream/x?q=1", o, a))
        assertEquals(a, authorizationFor("HTTP://192.168.1.5:8080/stream/x", o, a), "scheme case")
        assertNull(authorizationFor("https://192.168.1.5:8080/stream/x", o, a), "scheme-only mismatch")
        assertNull(authorizationFor("http://192.168.1.5:8081/stream/x", o, a), "port mismatch")
        assertNull(authorizationFor("http://192.168.1.6:8080/stream/x", o, a))
        assertNull(authorizationFor("https://i.ytimg.com/vi/x/mq.jpg", o, a))
        assertNull(authorizationFor("http://192.168.1.5:8080/stream/x", null, a), "no origin set yet")
        assertNull(authorizationFor("http://192.168.1.5:8080/stream/x", o, null), "no token")
        assertNull(authorizationFor("not a url", o, a))
        val host = origin("http://Yt.Home.LAN/stream/x")
        assertEquals("http://yt.home.lan:80", host)
        assertEquals(a, authorizationFor("http://YT.home.lan:80/stream/x", host, a), "host case and explicit default port")
        val v6 = origin("http://[::1]:8080/stream/x")
        assertEquals(a, authorizationFor("http://[0:0:0:0:0:0:0:1]:8080/stream/y", v6, a), "IPv6 spelling")
        assertNull(authorizationFor("http://[::2]:8080/stream/x", v6, a))
        assertNull(authorizationFor("http://127.0.0.1:8080/stream/x", v6, a))
    }

    @Test
    fun streamRequestAddsRangeAndAuthorizationOnlyWhenAllowed() {
        val o = origin("http://h:8080/")
        val r = streamRequest("http://h:8080/stream/x", mapOf("X-A" to "1"), 100, -1, o, "Bearer t")!!
        assertEquals("Bearer t", r.header("Authorization"))
        assertEquals("bytes=100-", r.header("Range"))
        assertEquals("1", r.header("X-A"))
        val other = streamRequest("https://i.ytimg.com/x.jpg", emptyMap(), 0, -1, o, "Bearer t")!!
        assertNull(other.header("Authorization"))
        assertNull(other.header("Range"))
        assertEquals("bytes=5-9", streamRequest("http://h:8080/s", emptyMap(), 5, 5, o, null)!!.header("Range"))
        assertNull(streamRequest("garbage", emptyMap(), 0, -1, o, "Bearer t"))
    }

    @Test
    fun authorizationDoesNotFollowACrossHostRedirect() {
        // "evil" is a second server on another port; the backend (first server) answers the stream with a redirect to it.
        val seen = mutableListOf<String?>()
        val evil = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        evil.createContext("/") { ex ->
            seen += ex.requestHeaders.getFirst("Authorization")
            ex.sendResponseHeaders(200, 2)
            ex.responseBody.use { it.write("ok".toByteArray()) }
        }
        evil.start()
        val home = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        home.createContext("/") { ex ->
            val sawAuth = ex.requestHeaders.getFirst("Authorization")
            ex.responseHeaders.add("Location", "http://127.0.0.1:${evil.address.port}/steal")
            ex.sendResponseHeaders(302, -1)
            ex.close()
            seen += "home:$sawAuth"
        }
        home.start()
        try {
            val url = "http://127.0.0.1:${home.address.port}/stream/x"
            val req = streamRequest(url, emptyMap(), 0, -1, origin(url), "Bearer $secret")!!
            assertEquals("Bearer $secret", req.header("Authorization"))
            val client: OkHttpClient = streamClient()
            client.newCall(req).execute().use { assertEquals(200, it.code) }
            assertTrue("home:Bearer $secret" in seen, "the configured server got the token")
            assertTrue(seen.filterNotNull().none { !it.startsWith("home:") }, "the redirect target must not get the token: $seen")
            assertTrue(seen.count { it == null } == 1)
        } finally {
            home.stop(0)
            evil.stop(0)
        }
    }
}
