package io.github.dodwmd.ytclassic.player

import android.net.Uri
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.PlaybackException
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import androidx.media3.datasource.HttpDataSource
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.io.InputStream
import java.util.concurrent.TimeUnit

/** scheme://host:port of a URL (default ports made explicit, host lower-cased), or null if it isn't an http(s) URL. */
internal fun origin(url: String): String? = url.toHttpUrlOrNull()?.let { "${it.scheme}://${it.host}:${it.port}" }

/**
 * The `Authorization` value to send for [url]: [auth] only when the URL's origin is exactly [streamOrigin] (same
 * scheme, host and port), otherwise null. The one place that decides where the access token may go.
 */
internal fun authorizationFor(url: String, streamOrigin: String?, auth: String?): String? {
    val o = origin(url) ?: return null
    return if (auth != null && streamOrigin != null && o == streamOrigin) auth else null
}

/** The request for one stream open: caller headers, a Range for a non-zero start, and the token only for the stream origin. */
internal fun streamRequest(url: String, headers: Map<String, String>, position: Long, length: Long, streamOrigin: String?, auth: String?): Request? {
    val http = url.toHttpUrlOrNull() ?: return null
    val b = Request.Builder().url(http)
    for ((k, v) in headers) b.header(k, v)
    if (position != 0L || length != C.LENGTH_UNSET.toLong()) {
        b.header("Range", "bytes=$position-" + if (length != C.LENGTH_UNSET.toLong()) (position + length - 1) else "")
    }
    authorizationFor(url, streamOrigin, auth)?.let { b.header("Authorization", it) }
    return b.build()
}

/** A client for the stream: no overall call timeout (streams are long), and OkHttp's default of dropping `Authorization` when a redirect changes host or port. */
internal fun streamClient(): OkHttpClient = OkHttpClient.Builder()
    .connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(30, TimeUnit.SECONDS)
    .build()

/**
 * ExoPlayer's HTTP source over OkHttp (already a dependency) instead of the built-in one, because the built-in
 * HttpURLConnection source re-sends every request header, including `Authorization`, to whatever host a redirect points at;
 * OkHttp drops it on a host or port change. [streamOrigin] and [auth] are read per open (set before each load).
 */
@OptIn(UnstableApi::class)
internal class AuthDataSource(
    private val client: OkHttpClient,
    private val streamOrigin: () -> String?,
    private val auth: () -> String?,
) : BaseDataSource(true), DataSource {
    private var response: Response? = null
    private var input: InputStream? = null
    private var remaining = C.LENGTH_UNSET.toLong()
    private var opened = false

    override fun open(dataSpec: DataSpec): Long {
        transferInitializing(dataSpec)
        val request = streamRequest(dataSpec.uri.toString(), dataSpec.httpRequestHeaders, dataSpec.position, dataSpec.length, streamOrigin(), auth())
            ?: throw HttpDataSource.HttpDataSourceException.createForIOException(
                IOException("Not an http(s) URL"), dataSpec, HttpDataSource.HttpDataSourceException.TYPE_OPEN,
            )
        val r = try {
            client.newCall(request).execute()
        } catch (e: IOException) {
            throw HttpDataSource.HttpDataSourceException.createForIOException(e, dataSpec, HttpDataSource.HttpDataSourceException.TYPE_OPEN)
        }
        response = r
        if (!r.isSuccessful) {
            val body = runCatching { r.body.bytes() }.getOrDefault(ByteArray(0))
            val headers = r.headers.toMultimap()
            close()
            throw HttpDataSource.InvalidResponseCodeException(r.code, r.message, null, headers, dataSpec, body)
        }
        val stream = r.body.byteStream()
        input = stream
        if (r.code == 200 && dataSpec.position > 0) { // the server ignored the Range: skip to the start ourselves
            var skip = dataSpec.position
            while (skip > 0) {
                val n = stream.skip(skip)
                if (n <= 0) break
                skip -= n
            }
        }
        val len = r.body.contentLength()
        remaining = when {
            dataSpec.length != C.LENGTH_UNSET.toLong() -> dataSpec.length
            len >= 0 -> len
            else -> C.LENGTH_UNSET.toLong()
        }
        opened = true
        transferStarted(dataSpec)
        return remaining
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (remaining == 0L) return C.RESULT_END_OF_INPUT
        val want = if (remaining == C.LENGTH_UNSET.toLong()) length else minOf(length.toLong(), remaining).toInt()
        val stream = input ?: return C.RESULT_END_OF_INPUT
        try {
            val n = stream.read(buffer, offset, want)
            if (n < 0) return C.RESULT_END_OF_INPUT // -1 = end of stream
            if (remaining != C.LENGTH_UNSET.toLong()) remaining -= n
            bytesTransferred(n)
            return n
        } catch (e: IOException) {
            throw HttpDataSource.HttpDataSourceException.createForIOException(
                e, DataSpec.Builder().setUri(getUri() ?: Uri.EMPTY).build(), HttpDataSource.HttpDataSourceException.TYPE_READ,
            )
        }
    }

    /** The final URL, after any redirects. */
    override fun getUri(): Uri? = response?.request?.url?.toString()?.let(Uri::parse)

    override fun getResponseHeaders(): Map<String, List<String>> = response?.headers?.toMultimap() ?: emptyMap()

    override fun close() {
        try {
            input?.close()
            response?.close()
        } finally {
            input = null
            response = null
            if (opened) {
                opened = false
                transferEnded()
            }
        }
    }
}
