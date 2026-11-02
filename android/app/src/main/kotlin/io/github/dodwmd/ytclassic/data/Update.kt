package io.github.dodwmd.ytclassic.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * The "new version available" check. The one place this app talks to GitHub, and only when the user asks (or has
 * turned the weekly check on). It uses its own client with no interceptors: the server's access token must never be
 * sent to GitHub.
 */
const val RELEASES_REPO = "dodwmd/yt-classic"
const val LATEST_RELEASE_API = "https://api.github.com/repos/$RELEASES_REPO/releases/latest"
const val UPDATE_CHECK_INTERVAL_MS = 7L * 24 * 60 * 60 * 1000

/** A version such as `0.1.0-2`: the app version, then the CD run number (releases are tagged `v<versionName>-<run>`). */
data class AppVersion(val major: Int, val minor: Int, val patch: Int, val build: Int) : Comparable<AppVersion> {
    override fun compareTo(other: AppVersion): Int =
        compareValuesBy(this, other, AppVersion::major, AppVersion::minor, AppVersion::patch, AppVersion::build)

}

private val VERSION = Regex("""v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-(\d{1,9}))?""")

/** `v1.2.3-rc1`: a pre-release. `releases/latest` never returns one; if one shows up it is ignored (up to date), not an error. */
private val PRERELEASE = Regex("""v?\d{1,6}\.\d{1,6}\.\d{1,6}-[0-9A-Za-z.]*[A-Za-z][0-9A-Za-z.]*""")

/**
 * "v0.1.0-2", "0.1.0-2" or "0.1.0" (no build number counts as build 0); anything else is null, never a guess:
 * no trimming (a tag with whitespace or a newline is not a tag), and the exact string is what the page URL uses.
 */
fun parseVersion(text: String): AppVersion? {
    val m = VERSION.matchEntire(text) ?: return null
    val (a, b, c, d) = m.destructured
    return AppVersion(a.toInt(), b.toInt(), c.toInt(), d.ifEmpty { "0" }.toInt())
}

/** The installed build: `versionName` plus the CD run number, which CI stores as `versionCode`. */
fun installedVersion(versionName: String, versionCode: Int): AppVersion? = parseVersion("$versionName-$versionCode")

sealed interface UpdateResult {
    data object UpToDate : UpdateResult

    /** [tag] is the release's own tag string, exactly as GitHub gave it and validated by [parseVersion]; [notes] is plain text, already shortened. */
    data class Available(val tag: String, val notes: String) : UpdateResult {
        /** Built only from the fixed repo and the validated tag, never from a URL in the response. */
        val pageUrl: String get() = releasePageUrl(tag)
    }

    data class Failed(val message: String) : UpdateResult
}

fun releasePageUrl(tag: String): String {
    require(parseVersion(tag) != null) { "not a release tag" }
    return "https://github.com/$RELEASES_REPO/releases/tag/$tag"
}

/** Release notes as plain text: control and format characters dropped, whitespace tidied, markdown left as it is, first [max] code points. */
fun releaseNotes(body: String?, max: Int = 500): String {
    // Control and format characters (bidi overrides, zero-width marks) are dropped: the text is shown as-is, not interpreted.
    val clean = (body ?: "").replace("\r", "")
        .filter { it == '\n' || !(it.isISOControl() || Character.getType(it) == Character.FORMAT.toInt()) }
        .trim().replace(Regex("\n{3,}"), "\n\n")
    // Cut by code point so a surrogate pair (emoji) is never split.
    return if (clean.codePointCount(0, clean.length) <= max) clean else clean.substring(0, clean.offsetByCodePoints(0, max)).trimEnd() + "…"
}

@Serializable
private class GithubRelease(val tag_name: String = "", val body: String? = null)

/** Whether to run the optional weekly check now. */
fun autoCheckDue(enabled: Boolean, lastCheckMs: Long, nowMs: Long): Boolean =
    enabled && (lastCheckMs <= 0 || nowMs - lastCheckMs >= UPDATE_CHECK_INTERVAL_MS || nowMs < lastCheckMs)

/** No interceptors, authenticators or cookies. No redirects either: the API answers directly, and a redirect (including https to http) is an error. */
fun newUpdateClient(): OkHttpClient = OkHttpClient.Builder()
    .callTimeout(8, TimeUnit.SECONDS)
    .followRedirects(false)
    .followSslRedirects(false)
    .build()

class UpdateChecker(
    private val installed: AppVersion?,
    private val client: OkHttpClient = newUpdateClient(),
    private val url: String = LATEST_RELEASE_API,
) {
    suspend fun check(): UpdateResult {
        val request = Request.Builder().url(url)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "yt-classic-android")
            .build()
        return try {
            val (code, text) = fetch(request)
            when {
                code == 403 || code == 429 -> UpdateResult.Failed("GitHub is limiting requests right now. Try again later.")
                code in 300..399 -> UpdateResult.Failed("GitHub redirected the request, which isn't followed. Try again later.")
                code == 404 -> UpdateResult.Failed("No release has been published yet.")
                code !in 200..299 -> UpdateResult.Failed("GitHub answered with an error ($code). Try again later.")
                else -> interpret(text)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            UpdateResult.Failed("Can't reach GitHub. Check your connection.")
        } catch (e: Exception) {
            UpdateResult.Failed("GitHub's answer wasn't understood.") // never let a surprise crash the app
        }
    }

    private fun interpret(text: String): UpdateResult {
        val release = try {
            ApiJson.decodeFromString<GithubRelease>(text)
        } catch (e: IllegalArgumentException) { // SerializationException is one
            return UpdateResult.Failed("GitHub's answer wasn't understood.")
        }
        if (PRERELEASE.matches(release.tag_name)) return UpdateResult.UpToDate
        val latest = parseVersion(release.tag_name) ?: return UpdateResult.Failed("GitHub's answer wasn't understood.")
        val here = installed ?: return UpdateResult.Failed("This build's version is unknown.")
        return if (latest > here) UpdateResult.Available(release.tag_name, releaseNotes(release.body)) else UpdateResult.UpToDate
    }

    // Blocking I/O off the main thread; the 8 s call timeout bounds it. The body is read up to 256 KB.
    private suspend fun fetch(request: Request): Pair<Int, String> = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { r ->
            val source = r.body.source()
            source.request(256_000)
            r.code to source.buffer.readUtf8()
        }
    }
}

/** The line shown for a check's outcome. */
fun updateSummary(r: UpdateResult): String = when (r) {
    UpdateResult.UpToDate -> "You're up to date."
    is UpdateResult.Available -> "Version ${r.tag.removePrefix("v")} is available."
    is UpdateResult.Failed -> r.message
}
