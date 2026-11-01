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
