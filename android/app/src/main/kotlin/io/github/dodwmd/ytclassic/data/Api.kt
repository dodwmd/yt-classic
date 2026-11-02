package io.github.dodwmd.ytclassic.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import okhttp3.Call
import okhttp3.Callback
import okhttp3.FormBody
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A failure with a message that is fit to show to the user. */
open class ApiException(
    message: String,
    cause: Throwable? = null,
    /** The backend's classified error code ("private", "rate-limited", ...), or null for older servers and local failures. */
    val code: String? = null,
    val retryable: Boolean = false,
) : Exception(message, cause)

/** The server wants an access token and the request had none ([tokenSet] false) or a wrong one. */
class AuthException(val tokenSet: Boolean) : ApiException(
    if (tokenSet) "The server rejected the access token: check it in Settings." else "Server needs an access token: set it in Settings.",
)

/** TV needs more subscriptions than the user has ([have] of [need]); [message] says how many more. */
class NeedSubscriptionsException(message: String, val have: Int, val need: Int) : ApiException(message)

/** Outcome of the Settings connection test. */
enum class ServerCheck(val message: String) {
    Ok("Connected"),
    Unreachable("Can't reach the server"),
    NeedsToken("Server needs an access token: enter it below."),
    TokenRejected("Token rejected: the server did not accept this access token."),
    TooManyAttempts("Too many failed attempts: wait a few minutes and try again."),
    Unexpected("The server gave an unexpected response. Is this the YouTube Classic backend?"),
}

/** "192.168.1.5:8080" -> "http://192.168.1.5:8080"; blank or unparseable -> null. */
fun normalizeServerUrl(raw: String): HttpUrl? {
    val trimmed = raw.trim()
    if (trimmed.isEmpty()) return null // (don't strip slashes first: that would turn "http://" into the host "http")
    val withScheme = if ("://" in trimmed) trimmed else "http://$trimmed"
    return withScheme.toHttpUrlOrNull()
}

/**
 * True when [host] is somewhere cleartext http is reasonable: loopback, a private/link-local/CGNAT (Tailscale) IPv4
 * range, an IPv6 local address, or a name that can't be on the public internet (no dots, .local, .lan, .home.arpa,
 * .internal, .ts.net). Used only to warn; the app still connects.
 */
fun isPrivateHost(host: String): Boolean {
    val h = host.trim('[', ']').lowercase()
    if (h.isEmpty()) return false
    val v4 = Regex("""(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})""").matchEntire(h)
    if (v4 != null) {
        val (a, b) = v4.groupValues[1].toInt() to v4.groupValues[2].toInt()
        return a == 10 || a == 127 || (a == 172 && b in 16..31) || (a == 192 && b == 168) ||
            (a == 169 && b == 254) || (a == 100 && b in 64..127)
    }
    if (':' in h) return h == "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")
    if ('.' !in h) return true
    return listOf(".local", ".lan", ".home.arpa", ".internal", ".ts.net").any { h.endsWith(it) }
}

val ApiJson = Json {
    ignoreUnknownKeys = true
    coerceInputValues = true
}

/** Client for the YouTube Classic backend. [server] is read on every call so a settings change applies immediately. */
class YtApi(
    private val server: suspend () -> String,
    /** The optional access token; sent as `Authorization: Bearer` to the configured server only. */
    private val token: suspend () -> String = { "" },
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS) // a cold home page can wait on several upstream fetches
        .build(),
) {
    suspend fun home(): HomeResponse = get("api/home")

    /** One page of the home feed: the first (no [before]) or the one after cursor [before]. Filters are always explicit. */
    suspend fun feed(filter: FeedFilter, before: String? = null): FeedPage =
        get("api/feed", *filter.query().toTypedArray(), "before" to before)

    suspend fun prefs(): FeedPrefs = get("api/prefs")

    suspend fun setPrefs(prefs: FeedPrefs): FeedPrefs = decode(execute(request(url("api/prefs")).post(
        FormBody.Builder().add("hideWatched", if (prefs.hideWatched) "1" else "0").add("shorts", prefs.shorts).add("live", prefs.live).build(),
    ).build()))

    /** Video search; [duration] is any|short|medium|long and [sort] relevance|date|views (see [SearchFilters]). */
    suspend fun search(query: String, pageToken: String? = null, duration: String? = null, sort: String? = null): SearchPage =
        get("api/search", "q" to query, "pageToken" to pageToken, "duration" to duration?.takeIf { it != "any" }, "sort" to sort?.takeIf { it != "relevance" })

    suspend fun searchChannels(query: String, pageToken: String? = null): ChannelSearchPage =
        get("api/search", "q" to query, "type" to "channel", "pageToken" to pageToken)

    /** Up to 8 completions of [query] (the server asks YouTube; an empty list when that is unavailable). */
    suspend fun suggest(query: String): List<String> = get<Suggestions>("api/search/suggest", "q" to query.trim().take(100)).suggestions

    suspend fun recentSearches(): List<RecentSearch> = get<RecentSearches>("api/searches").searches

    suspend fun removeRecentSearch(id: Long) {
        execute(request(url("api/searches/$id")).delete().build()).use { check(it) }
    }

    suspend fun clearRecentSearches() {
        execute(request(url("api/searches")).delete().build()).use { check(it) }
    }

    suspend fun video(id: String, quality: Int? = null): VideoResponse =
        get("api/video/$id", "q" to quality?.toString())

    suspend fun channel(id: String, pageToken: String? = null): ChannelResponse =
        get("api/channel/$id", "pageToken" to pageToken)

    suspend fun channelPlaylists(id: String, pageToken: String? = null): ChannelPlaylists =
        get<ChannelPlaylistsResponse>("api/channel/$id/playlists", "pageToken" to pageToken).page

    suspend fun channelPlaylist(id: String, playlistId: String, pageToken: String? = null): ChannelPlaylistResponse =
        get("api/channel/$id/playlist/$playlistId", "pageToken" to pageToken)

    /** [tab] is "shorts" or "live". */
    suspend fun channelTab(id: String, tab: String, pageToken: String? = null): SearchPage =
        get<ChannelTabResponse>("api/channel/$id/$tab", "pageToken" to pageToken).page

    suspend fun channelAbout(id: String): ChannelAbout = get<ChannelAboutResponse>("api/channel/$id/about").about

    suspend fun status(): StatusResponse = get("api/status")

    /** The next TV video: a random one from a subscribed channel other than [after], not in [seen] (the last ~50 ids). */
    suspend fun tvNext(after: String, seen: List<String>, quality: Int? = null): TvResponse =
        get("api/tv/next", "after" to after.ifEmpty { null }, "seen" to seen.joinToString(",").ifEmpty { null }, "q" to quality?.toString())

    suspend fun setSubscribed(channelId: String, subscribe: Boolean): Boolean {
        val body = FormBody.Builder().add("id", channelId).build()
        val req = request(url(if (subscribe) "api/subscribe" else "api/unsubscribe")).post(body).build()
        return decode<SubscribeResponse>(execute(req)).subscribed
    }

    /** Tells the server where playback is. The caller treats failure as unimportant. */
    suspend fun reportProgress(id: String, positionSeconds: Long, finished: Boolean = false) {
        val body = FormBody.Builder().add("id", id).add("position", positionSeconds.toString()).apply { if (finished) add("finished", "1") }.build()
        execute(request(url("api/progress")).post(body).build()).use { }
    }

    suspend fun history(before: String? = null): HistoryPage = get("api/history", "limit" to "48", "before" to before)

    /** Which of [ids] (at most 100) were watched to the end. */
    suspend fun watched(ids: List<String>): Set<String> =
        get<WatchedResponse>("api/history/watched", "ids" to ids.take(100).joinToString(",")).ids.toSet()

    suspend fun removeFromHistory(id: String) {
        execute(request(url("api/history/$id")).delete().build()).use { check(it) }
    }

    suspend fun clearHistory() {
        execute(request(url("api/history/clear")).post(FormBody.Builder().build()).build()).use { check(it) }
    }

    suspend fun playlists(): List<Playlist> = get<PlaylistsResponse>("api/playlists").playlists

    suspend fun playlist(id: Long, before: String? = null): PlaylistPage = get("api/playlists/$id", "limit" to "48", "before" to before)

    suspend fun createPlaylist(name: String): Playlist = sendForm("api/playlists", "name" to name).playlist ?: throw ApiException("Unexpected response from the server.")

    suspend fun renamePlaylist(id: Long, name: String): Playlist =
        sendForm("api/playlists/$id/rename", "name" to name).playlist ?: throw ApiException("Unexpected response from the server.")

    suspend fun deletePlaylist(id: Long) {
        decode<OkReply>(execute(request(url("api/playlists/$id")).delete().build()))
    }

    /** Adds the video (the server fills in its title and channel). Returns false when it was already in the playlist. */
    suspend fun addToPlaylist(id: Long, videoId: String): Boolean = sendForm("api/playlists/$id/items", "id" to videoId).added

    suspend fun removeFromPlaylist(id: Long, videoId: String) {
        decode<OkReply>(execute(request(url("api/playlists/$id/items/$videoId")).delete().build()))
    }

    suspend fun moveToTop(id: Long, videoId: String) {
        decode<OkReply>(execute(request(url("api/playlists/$id/move")).post(FormBody.Builder().add("id", videoId).add("index", "0").build()).build()))
    }

    /** Which of [ids] (at most 100) are in Watch later. */
    suspend fun inWatchLater(ids: List<String>): Set<String> =
        get<MembershipResponse>("api/playlists/membership", "ids" to ids.take(100).joinToString(",")).watchLater.toSet()

    private suspend fun sendForm(path: String, vararg fields: Pair<String, String>): PlaylistReply {
        val body = FormBody.Builder().apply { for ((k, v) in fields) add(k, v) }.build()
        return decode(execute(request(url(path)).post(body).build()))
    }

    private suspend fun check(r: Response) {
        if (r.code == 401) throw AuthException(token().isNotBlank())
        if (!r.isSuccessful) throw apiErrorFrom(r.code, withContext(Dispatchers.IO) { r.body.string() }) // keeps the server's code and message
    }

    /**
     * Imports a Takeout CSV, an OPML file or a list of channel links (the backend detects which, and UTF-8 or UTF-16).
     * The file's own bytes are sent: re-encoding decoded text could change the size or the characters.
     */
    suspend fun importSubscriptions(bytes: ByteArray): ImportResult {
        val body = bytes.toRequestBody("text/plain".toMediaType())
        return decode(execute(request(url("api/subscriptions/import")).post(body).build()))
    }

    /** The whole export file as text; [format] is "csv" or "opml". */
    suspend fun exportSubscriptions(format: String): String = withContext(Dispatchers.IO) {
        execute(request(url("api/subscriptions/export", "format" to format)).build()).use {
            val text = it.body.string()
            if (it.code == 401) throw AuthException(token().isNotBlank())
            if (!it.isSuccessful) throw apiErrorFrom(it.code, text)
            text
        }
    }

    /**
     * Checks that the server answers and whether the token (if any) is accepted; used by the settings screen.
     * `/healthz` is open; `/api/session` says whether a token is needed. Only a 404 there (a server that predates the
     * token, so open) or a well-formed session body counts as success; anything else is reported, never as "Connected".
     */
    suspend fun check(): ServerCheck {
        try {
            if (!execute(Request.Builder().url(url("healthz")).build()).use { it.isSuccessful }) return ServerCheck.Unreachable
            val session = execute(request(url("api/session")).build())
            val haveToken = token().isNotBlank()
            return withContext(Dispatchers.IO) {
                session.use {
                    when {
                        it.code == 404 -> ServerCheck.Ok
                        it.code == 429 -> ServerCheck.TooManyAttempts
                        it.code == 401 -> if (haveToken) ServerCheck.TokenRejected else ServerCheck.NeedsToken
                        !it.isSuccessful -> ServerCheck.Unexpected
                        else -> {
                            val s = runCatching { ApiJson.decodeFromString<SessionResponse>(it.body.string()) }.getOrNull()
                            when {
                                s == null || s.auth !in setOf("none", "required") -> ServerCheck.Unexpected
                                s.auth == "none" || s.authenticated -> ServerCheck.Ok
                                haveToken -> ServerCheck.TokenRejected
                                else -> ServerCheck.NeedsToken
                            }
                        }
                    }
                }
            }
        } catch (_: ApiException) {
            return ServerCheck.Unreachable
        }
    }

    /** The `Authorization` value for the stream, or null when no token is set. Only valid for the host of [streamUrl]. */
    suspend fun streamAuthorization(): String? = token().trim().takeIf { it.isNotEmpty() }?.let { "Bearer $it" }

    /** The live stream; [startSeconds] restarts it at that offset (the backend remuxes on the fly, so seeking = restarting). */
    suspend fun streamUrl(id: String, quality: Int, startSeconds: Long = 0, lang: String = ""): String =
        url("stream/$id", "q" to quality.toString(), "a" to lang.ifEmpty { null }, "t" to startSeconds.takeIf { it > 0 }?.toString()).toString()

    private suspend fun url(path: String, vararg query: Pair<String, String?>): HttpUrl {
        val base = normalizeServerUrl(server()) ?: throw ApiException("Set the server address in Settings first.")
        return base.newBuilder().addPathSegments(path).apply {
            for ((k, v) in query) if (v != null) addQueryParameter(k, v)
        }.build()
    }

    /** Every API request is built here, so the token only ever goes to the configured server. */
    private suspend fun request(url: HttpUrl): Request.Builder {
        val b = Request.Builder().url(url)
        token().trim().takeIf { it.isNotEmpty() }?.let { b.header("Authorization", "Bearer $it") }
        return b
    }

    private suspend inline fun <reified T> get(path: String, vararg query: Pair<String, String?>): T =
        decode(execute(request(url(path, *query)).build()))

    // Reading the body is blocking I/O: it must not run on the main thread (the caller's dispatcher in the UI).
    private suspend inline fun <reified T> decode(response: Response): T = withContext(Dispatchers.IO) {
      response.use {
        val text = it.body.string()
        if (it.code == 401) throw AuthException(token().isNotBlank())
        if (!it.isSuccessful) {
            val error = runCatching { ApiJson.decodeFromString<ApiError>(text) }.getOrDefault(ApiError())
            if (it.code == 409 && error.code == "need-subscriptions") throw NeedSubscriptionsException(error.error.ifBlank { "Subscribe to more channels to turn on TV." }, error.have, error.need)
            throw apiErrorFrom(it.code, text)
        }
        try {
            ApiJson.decodeFromString(ApiJson.serializersModule.serializer<T>(), text)
        } catch (e: Exception) {
            throw ApiException("Unexpected response from the server.", e)
        }
      }
    }

    private suspend fun execute(request: Request): Response = suspendCancellableCoroutine { cont ->
        val call = client.newCall(request)
        cont.invokeOnCancellation { call.cancel() }
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                cont.resumeWithException(ApiException("Can't reach the server (${e.message ?: e.javaClass.simpleName}).", e))
            }

            override fun onResponse(call: Call, response: Response) = cont.resume(response)
        })
    }
}
