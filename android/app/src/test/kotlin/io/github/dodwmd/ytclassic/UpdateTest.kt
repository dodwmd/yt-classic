package io.github.dodwmd.ytclassic

import com.sun.net.httpserver.HttpServer
import io.github.dodwmd.ytclassic.data.AppVersion
import io.github.dodwmd.ytclassic.data.UPDATE_CHECK_INTERVAL_MS
import io.github.dodwmd.ytclassic.data.UpdateChecker
import io.github.dodwmd.ytclassic.data.UpdateResult
import io.github.dodwmd.ytclassic.data.autoCheckDue
import io.github.dodwmd.ytclassic.data.formatLikes
import io.github.dodwmd.ytclassic.data.installedVersion
import io.github.dodwmd.ytclassic.data.newUpdateClient
import okhttp3.Authenticator
import okhttp3.CookieJar
import okhttp3.OkHttpClient
import java.util.concurrent.TimeUnit
import io.github.dodwmd.ytclassic.data.parseVersion
import io.github.dodwmd.ytclassic.data.releaseNotes
import io.github.dodwmd.ytclassic.data.releasePageUrl
import io.github.dodwmd.ytclassic.data.updateSummary
import io.github.dodwmd.ytclassic.ui.listColumns
import io.github.dodwmd.ytclassic.ui.useTwoPane
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

class UpdateTest {
    private lateinit var server: HttpServer
    private val seenHeaders = mutableListOf<Map<String, List<String>>>()
    private var delayMs = 0L
    private var redirectHits = 0
    private var reply = 200 to """{"tag_name":"v0.1.0-5","body":"notes"}"""

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            seenHeaders += ex.requestHeaders.entries.associate { it.key.lowercase() to it.value }
            if (ex.requestURI.path == "/elsewhere") redirectHits++
            if (delayMs > 0) Thread.sleep(delayMs)
            val bytes = reply.second.toByteArray()
            if (reply.first in 300..399) ex.responseHeaders.add("Location", "http://127.0.0.1:${server.address.port}/elsewhere")
            ex.sendResponseHeaders(reply.first, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
    }

    @AfterTest
    fun stop() = server.stop(0)

    private fun check(installed: String, client: OkHttpClient = newUpdateClient()): UpdateResult =
        runBlocking { UpdateChecker(parseVersion(installed), client, "http://127.0.0.1:${server.address.port}/latest").check() }

    @Test
    fun `parses the tag formats the release workflow produces`() {
        assertEquals(AppVersion(0, 1, 0, 2), parseVersion("v0.1.0-2"))
        assertEquals(AppVersion(0, 1, 0, 2), parseVersion("0.1.0-2"))
        assertEquals(AppVersion(0, 1, 0, 0), parseVersion("0.1.0"))
        assertEquals(AppVersion(12, 3, 4, 120), parseVersion("v12.3.4-120"))
        assertEquals(AppVersion(1, 2, 3, 4), parseVersion("v01.02.003-0004")) // leading zeros are numbers, not errors
        assertEquals(AppVersion(0, 1, 0, 7), installedVersion("0.1.0", 7))
    }

    @Test
    fun `rejects anything that is not a release tag`() {
        for (bad in listOf("", "latest", "v1", "v1.2", "v1.2.3-", "v1.2.3-rc1", "v1.2.3-4-5", "1.2.3/../x", "v1.2.3-99999999999", "v1.2.3 evil", " v1.2.3-4", "v1.2.3-4 ", "v1.2.3\n", "\nv1.2.3-4", "v1.2.3-4\n")) {
            assertNull(parseVersion(bad), bad)
        }
    }

    @Test
    fun `orders by version and then build number`() {
        assertTrue(parseVersion("v0.1.0-2")!! > parseVersion("0.1.0")!!)
        assertTrue(parseVersion("v0.1.0-10")!! > parseVersion("v0.1.0-9")!!) // numerically, not as text
        assertTrue(parseVersion("v0.2.0-1")!! > parseVersion("v0.1.9-999")!!)
        assertTrue(parseVersion("v1.0.0-1")!! > parseVersion("v0.99.99-99")!!)
        assertEquals(0, parseVersion("v0.1.0-2")!!.compareTo(parseVersion("0.1.0-2")!!))
    }

    @Test
    fun `newer release is available, same or older is up to date`() {
        reply = 200 to """{"tag_name":"v0.1.0-5","body":"notes"}"""
        val newer = check("0.1.0-4") as UpdateResult.Available
        assertEquals("v0.1.0-5", newer.tag)
        assertEquals("notes", newer.notes)
        assertEquals("Version 0.1.0-5 is available.", updateSummary(newer))
        assertEquals(UpdateResult.UpToDate, check("0.1.0-5"))
        assertEquals(UpdateResult.UpToDate, check("0.1.0-9"))
        assertEquals("You're up to date.", updateSummary(UpdateResult.UpToDate))
    }

    @Test
    fun `the page url is the fixed repo plus the validated tag, never a url from the response`() {
        reply = 200 to """{"tag_name":"v0.1.0-5","html_url":"https://evil.example/x","body":"b"}"""
        val r = check("0.1.0-1") as UpdateResult.Available
        assertEquals("https://github.com/dodwmd/yt-classic/releases/tag/v0.1.0-5", r.pageUrl)
        assertFailsWith<IllegalArgumentException> { releasePageUrl("v1.0.0/../../evil") }
        reply = 200 to """{"tag_name":"https://evil.example/","body":"b"}"""
        assertTrue(check("0.1.0-1") is UpdateResult.Failed)
    }

    @Test
    fun `the update client has no interceptors, authenticator or cookies, and sends no Authorization or Cookie`() {
        val c = newUpdateClient()
        assertTrue(c.interceptors.isEmpty() && c.networkInterceptors.isEmpty())
        assertEquals(Authenticator.NONE, c.authenticator)
        assertEquals(Authenticator.NONE, c.proxyAuthenticator)
        assertEquals(CookieJar.NO_COOKIES, c.cookieJar)
        assertFalse(c.followRedirects || c.followSslRedirects)
        check("0.1.0-1", c)
        assertEquals(1, seenHeaders.size)
        assertFalse(seenHeaders[0].containsKey("authorization"))
        assertFalse(seenHeaders[0].containsKey("cookie"))
        assertEquals(listOf("application/vnd.github+json"), seenHeaders[0]["accept"])
    }

    @Test
    fun `rate limits, missing releases, server errors and junk are reported not thrown`() {
        for (code in listOf(403, 429)) {
            reply = code to """{"message":"API rate limit exceeded"}"""
            assertTrue((check("0.1.0-1") as UpdateResult.Failed).message.contains("limiting"), "$code")
        }
        reply = 404 to "{}"
        assertTrue((check("0.1.0-1") as UpdateResult.Failed).message.contains("No release"))
        reply = 500 to "oops"
        assertTrue(check("0.1.0-1") is UpdateResult.Failed)
        reply = 200 to "not json"
        assertTrue(check("0.1.0-1") is UpdateResult.Failed)
        reply = 200 to """{"tag_name":"v0.1.0-5"}"""
        assertEquals(UpdateResult.Available("v0.1.0-5", ""), check("0.1.0-1")) // no notes is fine
    }

    @Test
    fun `redirects are not followed`() {
        for (code in listOf(301, 302)) {
            reply = code to ""
            assertTrue(check("0.1.0-1") is UpdateResult.Failed, "$code")
        }
        assertEquals(0, redirectHits)
    }

    @Test
    fun `malformed json is a failure, not a crash`() {
        for (body in listOf("""{"tag_name":5}""", """{"tag_name":null}""", """{"tag_name":["v1.0.0-1"]}""", "[]", "null", "", """{"tag_name":"v1.0.0-1","body":{"x":1}}""", "{")) {
            reply = 200 to body
            assertTrue(check("0.1.0-1") is UpdateResult.Failed, body)
        }
    }

    @Test
    fun `tags with whitespace, other junk or path tricks are failures`() {
        for (tag in listOf(" v0.1.0-5", "v0.1.0-5\n", "v0.1.0-5/../x", "v0.1.0-5?x=1", "v0.1.0-5#f")) {
            reply = 200 to """{"tag_name":"${tag.replace("\n", "\\n")}"}"""
            assertTrue(check("0.1.0-1") is UpdateResult.Failed, tag)
        }
    }

    @Test
    fun `the page url uses the tag exactly as released`() {
        reply = 200 to """{"tag_name":"v01.2.3-04"}"""
        assertEquals("https://github.com/dodwmd/yt-classic/releases/tag/v01.2.3-04", (check("0.1.0-1") as UpdateResult.Available).pageUrl)
        reply = 200 to """{"tag_name":"0.2.0-1"}"""
        assertEquals("https://github.com/dodwmd/yt-classic/releases/tag/0.2.0-1", (check("0.1.0-1") as UpdateResult.Available).pageUrl)
    }

    @Test
    fun `a pre-release tag is ignored, not an error`() {
        reply = 200 to """{"tag_name":"v0.2.0-rc1","body":"x"}"""
        assertEquals(UpdateResult.UpToDate, check("0.1.0-1"))
    }

    @Test
    fun `a huge body is read only up to the cap and then fails to parse`() {
        reply = 200 to ("""{"tag_name":"v9.0.0-1","body":"""" + "a".repeat(600_000) + """"}""")
        assertTrue(check("0.1.0-1") is UpdateResult.Failed)
    }

    @Test
    fun `a slow answer times out`() {
        delayMs = 3000
        val quick = OkHttpClient.Builder().callTimeout(300, TimeUnit.MILLISECONDS).build()
        val r = check("0.1.0-1", quick)
        assertTrue((r as UpdateResult.Failed).message.contains("Can't reach GitHub"))
    }

    @Test
    fun `offline is reported`() {
        server.stop(0)
        val r = runBlocking { UpdateChecker(parseVersion("0.1.0-1"), url = "http://127.0.0.1:${server.address.port}/latest").check() }
        assertTrue((r as UpdateResult.Failed).message.contains("Can't reach GitHub"))
    }

    @Test
    fun `unknown installed version is not guessed`() {
        assertTrue(runBlocking { UpdateChecker(null, url = "http://127.0.0.1:${server.address.port}/latest").check() } is UpdateResult.Failed)
    }

    @Test
    fun `release notes are plain text, cleaned and shortened`() {
        assertEquals("", releaseNotes(null))
        assertEquals("a\n\nb", releaseNotes("  a\r\n\n\n\n\u0007b \n"))
        val long = releaseNotes("x".repeat(900))
        assertEquals(501, long.length)
        assertTrue(long.endsWith("…"))
        assertEquals(10, releaseNotes("y".repeat(10)).length)
        // bidi overrides and zero-width characters are removed
        assertEquals("abc", releaseNotes("a\u202Eb\u200Bc\u2066"))
        // cut by code point: no half of an emoji
        val emoji = releaseNotes("\uD83D\uDE00".repeat(600))
        assertEquals(501, emoji.codePointCount(0, emoji.length))
        assertTrue(emoji.dropLast(1).last().isLowSurrogate()) // ends on a whole pair
    }

    @Test
    fun `weekly check runs only when enabled and a week has passed`() {
        val now = 10 * UPDATE_CHECK_INTERVAL_MS
        assertFalse(autoCheckDue(false, 0, now))
        assertTrue(autoCheckDue(true, 0, now))
        assertFalse(autoCheckDue(true, now - UPDATE_CHECK_INTERVAL_MS + 1, now))
        assertTrue(autoCheckDue(true, now - UPDATE_CHECK_INTERVAL_MS, now))
        assertTrue(autoCheckDue(true, now + 5, now)) // clock went backwards
    }

    @Test
    fun `likes are formatted like views and hidden when unknown`() {
        assertEquals("19,492,192 likes", formatLikes("19492192"))
        assertEquals("1 like", formatLikes("1"))
        assertEquals("", formatLikes(null))
        assertEquals("", formatLikes(""))
        assertEquals("", formatLikes("hidden"))
    }

    @Test
    fun `two panes on tablets and in landscape, one column on portrait phones`() {
        assertFalse(useTwoPane(412, 892))
        assertTrue(useTwoPane(892, 412)) // phone landscape
        assertTrue(useTwoPane(600, 960)) // small tablet portrait
        assertTrue(useTwoPane(800, 1280))
        assertFalse(useTwoPane(599, 600))
        assertFalse(useTwoPane(479, 300)) // narrow split-screen window
        assertTrue(useTwoPane(480, 300))
        assertEquals(1, listColumns(839))
        assertEquals(2, listColumns(840))
    }
}
