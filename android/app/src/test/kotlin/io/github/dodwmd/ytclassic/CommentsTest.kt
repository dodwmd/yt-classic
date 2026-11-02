package io.github.dodwmd.ytclassic

import com.sun.net.httpserver.HttpServer
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.AuthException
import io.github.dodwmd.ytclassic.data.Comment
import io.github.dodwmd.ytclassic.data.PageState
import io.github.dodwmd.ytclassic.data.commentFooter
import io.github.dodwmd.ytclassic.data.repliesDescription
import java.util.Locale
import io.github.dodwmd.ytclassic.data.COMMENTS_DISABLED_CODE
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.commentAge
import io.github.dodwmd.ytclassic.data.commentsToggleLabel
import io.github.dodwmd.ytclassic.data.errorActions
import io.github.dodwmd.ytclassic.data.likesLabel
import io.github.dodwmd.ytclassic.data.repliesLabel
import io.github.dodwmd.ytclassic.ui.CommentsModel
import io.github.dodwmd.ytclassic.ui.loadFirst
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import io.github.dodwmd.ytclassic.ui.PagedList
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import java.net.InetSocketAddress
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

private const val VID = "dQw4w9WgXcQ"
private const val OFF = "offOffOff01"
private const val T1 = "UgxAAAAAAAAAAAAAAAAAAAAAAAAA"

/** The comment calls, against responses captured from this repo's own backend with a stubbed Data API (src/test/resources/comments-*.json). */
class CommentsTest {
    private lateinit var server: HttpServer
    private val requests = mutableListOf<String>()
    private val auth = mutableListOf<String?>()
    private var needToken = false
    private var gate: CompletableDeferred<Unit>? = null
    private lateinit var api: YtApi

    private fun fixture(name: String) = javaClass.getResource("/$name.json")!!.readText()

    @BeforeTest
    fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/") { ex ->
            requests += "${ex.requestMethod} ${ex.requestURI}"
            auth += ex.requestHeaders.getFirst("Authorization")
            val path = ex.requestURI.path
            val query = ex.requestURI.query.orEmpty()
            val (status, body) = when {
                needToken && ex.requestHeaders.getFirst("Authorization") != "Bearer s3cret" -> 401 to """{"error":"unauthorized"}"""
                path == "/api/video/$OFF/comments" -> 403 to fixture("comments-disabled")
                path == "/api/video/$VID/comments" && "order=new" in query -> 200 to fixture("comments-empty")
                path == "/api/video/$VID/comments" && "pageToken=PAGE2" in query -> 200 to fixture("comments-page2")
                path == "/api/video/$VID/comments" -> 200 to fixture("comments-page1")
                path == "/api/comments/$T1/replies" -> 200 to fixture("comments-replies")
                else -> 404 to """{"error":"not found"}"""
            }
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(status, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        server.start()
        api = YtApi(server = { "127.0.0.1:${server.address.port}" }, token = { if (needToken) "s3cret" else "" })
    }

    /** Waits for the request a [PagedList] started (the network answers on another thread). */
    private suspend fun <T> PagedList<T>.settled(): PagedList<T> {
        withTimeout(10_000) { while (state.loading) delay(5) }
        return this
    }

    @AfterTest
    fun stop() = server.stop(0)

    @Test
    fun theFirstPageParsesAsPlainText() = runBlocking {
        val p = api.comments(VID, "top")
        assertEquals("GET /api/video/$VID/comments?order=top", requests.last())
        assertEquals(5, p.items.size)
        assertEquals("PAGE2", p.nextPageToken)
        val c = p.items.first()
        assertEquals(T1, c.id)
        assertEquals("Bob Co", c.author)
        assertTrue(c.text.startsWith("Great & fun <3 https://example.com/x\nline two a<b and c>d <div> &amp;"), c.text)
        assertTrue("😀" in c.text, "emoji survive")
        assertEquals(7, c.likeCount)
        assertEquals(3, c.replyCount)
        assertNull(c.authorThumb, "the backend drops non-https avatars")
        assertNull(p.items[1].authorThumb, "and avatars from other hosts")
        assertEquals("https://i.ytimg.com/a.jpg", p.items[3].authorThumb)
        assertNull(c.updatedAt)
        val long = p.items[4]
        assertEquals(100, long.author.length)
        assertEquals(5000, long.text.length)
        assertEquals("https://yt3.ggpht.com/a=s48", long.authorThumb)
        assertEquals("2024-06-01T10:00:00Z", long.updatedAt)
    }

    @Test
    fun theTokenAndOrderAreSent_andTheLastPageHasNoToken() = runBlocking {
        val p = api.comments(VID, "top", "PAGE2")
        assertEquals("GET /api/video/$VID/comments?order=top&pageToken=PAGE2", requests.last())
        assertEquals("second", p.items.single().text)
        assertNull(p.nextPageToken)
        assertTrue(api.comments(VID, "new").items.isEmpty())
        assertEquals("GET /api/video/$VID/comments?order=new", requests.last())
    }

    @Test
    fun repliesAreAFlatListWithTheirOwnIds() = runBlocking {
        val r = api.commentReplies(T1)
        assertEquals("GET /api/comments/$T1/replies", requests.last())
        assertEquals(listOf("$T1.r1", "$T1.r2"), r.items.map { it.id })
        assertEquals("reply & one", r.items[0].text)
        assertTrue(r.items.all { it.replyCount == 0 })
        assertEquals("RPAGE2", r.nextPageToken)
        api.commentReplies(T1, "RPAGE2")
        assertEquals("GET /api/comments/$T1/replies?pageToken=RPAGE2", requests.last())
    }

    @Test
    fun turnedOffCommentsAreAClassifiedNonRetryableError() = runBlocking {
        val e = assertFailsWith<ApiException> { api.comments(OFF, "top") }
        assertEquals(COMMENTS_DISABLED_CODE, e.code)
        assertEquals("Comments are turned off for this video.", e.message)
        assertFalse(e.retryable)
        assertFalse(errorActions(e.code, e.retryable).showRetry, "no Retry for something that will not change")
    }

    @Test
    fun everyCallSendsTheBearerTokenAndSurfacesRejection() = runBlocking {
        needToken = true
        api.comments(VID, "top"); api.commentReplies(T1)
        assertEquals(listOf<String?>("Bearer s3cret", "Bearer s3cret"), auth)
        val bad = YtApi(server = { "127.0.0.1:${server.address.port}" }, token = { "wrong" })
        assertFailsWith<AuthException> { bad.comments(VID, "top") }
        assertFailsWith<AuthException> { bad.commentReplies(T1) }
        assertEquals(4, auth.size)
    }

    @Test
    fun theModelRequestsNothingUntilAListIsLoaded_andLoadsEachListOnce() = runBlocking {
        val model = CommentsModel(api, VID, CoroutineScope(Dispatchers.Unconfined))
        assertEquals(0, requests.size, "closed sections cost nothing")
        model.top.loadFirst(); model.top.loadFirst()
        model.top.settled()
        assertEquals(1, requests.size)
        assertEquals(5, model.top.state.items.size)
        assertTrue(model.top.state.canLoadMore)
        model.top.load()
        model.top.settled()
        assertEquals(6, model.top.state.items.size)
        assertFalse(model.top.state.canLoadMore, "no token on the last page")
        model.newest.loadFirst()
        model.newest.settled()
        assertTrue(model.newest.state.started && model.newest.state.items.isEmpty() && model.newest.state.token == null, "empty is the end, not an error")
        assertEquals(6, model.top.state.items.size, "Top keeps what it loaded while Newest is shown")
        // replies: a list per thread, loaded once
        val r = model.replies(T1)
        assertTrue(r === model.replies(T1))
        r.loadFirst(); r.loadFirst()
        r.settled()
        assertEquals(listOf("$T1.r1", "$T1.r2"), r.state.items.map { it.id })
        assertEquals(1, requests.count { "/replies" in it })
    }

    @Test
    fun aFailedFirstLoadKeepsItsErrorForRetry_andDisabledStaysDisabled() = runBlocking {
        val off = CommentsModel(api, OFF, CoroutineScope(Dispatchers.Unconfined))
        off.top.loadFirst()
        off.top.settled()
        assertEquals(COMMENTS_DISABLED_CODE, off.top.state.code)
        assertFalse(off.top.state.retryable)
        assertFalse(off.top.state.started)
        off.top.loadFirst() // the screen's effect runs again after rotation: no second request while the error stands
        assertEquals(1, requests.size)
    }

    @Test
    fun labelsAndMeta() {
        assertEquals("Show comments (1,234)", commentsToggleLabel(1234, open = false))
        assertEquals("Hide comments (5)", commentsToggleLabel(5, open = true))
        assertEquals("Show comments", commentsToggleLabel(null, open = false))
        assertEquals("Show 1 reply", repliesLabel(1, open = false))
        assertEquals("Hide 1,200 replies", repliesLabel(1200, open = true))
        assertEquals("", likesLabel(0))
        assertEquals("1 like", likesLabel(1))
        assertEquals("12,345 likes", likesLabel(12345))
        val now = java.time.Instant.parse("2024-05-03T10:00:00Z").toEpochMilli()
        val c = Comment("x", publishedAt = "2024-05-01T10:00:00Z")
        assertEquals("2 days ago", commentAge(c, now))
        assertEquals("2 days ago · (edited)", commentAge(c.copy(updatedAt = "2024-05-02T10:00:00Z"), now))
        assertEquals("(edited)", commentAge(Comment("y", updatedAt = "2024-05-02T10:00:00Z"), now))
    }

    @Test
    fun labelsDoNotDependOnTheDeviceLocale() {
        val saved = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY) // "1.234" with a dot, not a comma
            assertEquals("Show comments (1,234)", commentsToggleLabel(1234, open = false))
            assertEquals("Hide 1,200 replies", repliesLabel(1200, open = true))
            assertEquals("12,345 likes", likesLabel(12345))
            assertEquals("Show 3 replies to Bob", repliesDescription(3, false, "Bob"))
            assertEquals("Hide 1 reply to this comment", repliesDescription(1, true, ""))
        } finally {
            Locale.setDefault(saved)
        }
    }

    @Test
    fun theFooterShowsExactlyWhatEachStateNeeds() {
        val c = Comment("a")
        val fresh = PageState<Comment>()
        assertEquals(false, commentFooter(fresh).empty, "before the first request nothing is claimed")
        assertTrue(commentFooter(fresh.begin()).spinner)
        val loaded = PageState(listOf(c), token = "T", started = true)
        assertTrue(commentFooter(loaded).loadMore)
        assertFalse(commentFooter(loaded.begin()).loadMore, "no second Load more while loading")
        assertTrue(commentFooter(PageState<Comment>(started = true)).empty)
        assertFalse(commentFooter(PageState<Comment>(started = true, token = "T")).empty, "a next page may still have some")
        val failed = loaded.copy(error = "Couldn't reach YouTube.", code = "network", retryable = true)
        val f = commentFooter(failed)
        assertTrue(f.retry && f.message == "Couldn't reach YouTube." && !f.loadMore && f.hint != null)
        val off = commentFooter(PageState<Comment>(error = "whatever an old server says", code = "comments-disabled", retryable = false))
        assertEquals("Comments are turned off for this video.", off.message)
        assertTrue(off.muted && !off.retry && off.hint == null)
        assertTrue(commentFooter(PageState<Comment>(error = "x", needsToken = true)).openSettings)
        assertEquals(200, commentFooter(PageState<Comment>(error = "y".repeat(500))).message!!.length)
    }
}
