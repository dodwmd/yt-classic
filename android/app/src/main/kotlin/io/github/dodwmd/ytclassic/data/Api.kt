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
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** A failure with a message that is fit to show to the user. */
class ApiException(message: String, cause: Throwable? = null) : Exception(message, cause)

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
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS) // a cold home page can wait on several upstream fetches
        .build(),
) {
    suspend fun home(): HomeResponse = get("api/home")

    suspend fun search(query: String, pageToken: String? = null): SearchPage =
        get("api/search", "q" to query, "pageToken" to pageToken)

    suspend fun video(id: String, quality: Int? = null): VideoResponse =
        get("api/video/$id", "q" to quality?.toString())

    suspend fun channel(id: String, pageToken: String? = null): ChannelResponse =
        get("api/channel/$id", "pageToken" to pageToken)

    suspend fun setSubscribed(channelId: String, subscribe: Boolean): Boolean {
        val body = FormBody.Builder().add("id", channelId).build()
        val req = Request.Builder().url(url(if (subscribe) "api/subscribe" else "api/unsubscribe")).post(body).build()
        return decode<SubscribeResponse>(execute(req)).subscribed
    }

    /** Tells the server where playback is. The caller treats failure as unimportant. */
    suspend fun reportProgress(id: String, positionSeconds: Long, finished: Boolean = false) {
        val body = FormBody.Builder().add("id", id).add("position", positionSeconds.toString()).apply { if (finished) add("finished", "1") }.build()
        execute(Request.Builder().url(url("api/progress")).post(body).build()).use { }
    }

    suspend fun history(before: Long? = null): HistoryPage = get("api/history", "limit" to "48", "before" to before?.toString())

    /** Which of [ids] (at most 100) were watched to the end. */
    suspend fun watched(ids: List<String>): Set<String> =
        get<WatchedResponse>("api/history/watched", "ids" to ids.take(100).joinToString(",")).ids.toSet()

    suspend fun removeFromHistory(id: String) {
        execute(Request.Builder().url(url("api/history/$id")).delete().build()).use { check(it) }
    }

    suspend fun clearHistory() {
        execute(Request.Builder().url(url("api/history/clear")).post(FormBody.Builder().build()).build()).use { check(it) }
    }

    private fun check(r: Response) {
        if (!r.isSuccessful) throw ApiException("Request failed (${r.code})")
    }

    /** Checks that the configured server answers; used by the settings screen. */
    suspend fun ping(): Boolean = try {
        execute(Request.Builder().url(url("healthz")).build()).use { it.isSuccessful }
    } catch (_: ApiException) {
        false
    }

    /** The live stream; [startSeconds] restarts it at that offset (the backend remuxes on the fly, so seeking = restarting). */
    suspend fun streamUrl(id: String, quality: Int, startSeconds: Long = 0, lang: String = ""): String =
        url("stream/$id", "q" to quality.toString(), "a" to lang.ifEmpty { null }, "t" to startSeconds.takeIf { it > 0 }?.toString()).toString()

    private suspend fun url(path: String, vararg query: Pair<String, String?>): HttpUrl {
        val base = normalizeServerUrl(server()) ?: throw ApiException("Set the server address in Settings first.")
        return base.newBuilder().addPathSegments(path).apply {
            for ((k, v) in query) if (v != null) addQueryParameter(k, v)
        }.build()
    }

    private suspend inline fun <reified T> get(path: String, vararg query: Pair<String, String?>): T =
        decode(execute(Request.Builder().url(url(path, *query)).build()))

    // Reading the body is blocking I/O: it must not run on the main thread (the caller's dispatcher in the UI).
    private suspend inline fun <reified T> decode(response: Response): T = withContext(Dispatchers.IO) {
      response.use {
        val text = it.body.string()
        if (!it.isSuccessful) {
            val message = runCatching { ApiJson.decodeFromString<ApiError>(text).error }.getOrDefault("")
            throw ApiException(message.ifBlank { "Request failed (${it.code})" })
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
