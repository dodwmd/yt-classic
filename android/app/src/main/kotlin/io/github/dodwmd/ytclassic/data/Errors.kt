package io.github.dodwmd.ytclassic.data

/**
 * The backend's classified error codes (see the README table). Anything else, or no code at all (an older server),
 * is treated as unknown: a generic Retry.
 */
private val SKIPPABLE = setOf("age-restricted", "region-blocked", "private", "removed", "members-only", "live", "upcoming")
private val RETRY_WITH_HINT = mapOf(
    "rate-limited" to "YouTube is limiting the server for now, so retrying right away won't help.",
    "bot-check" to "YouTube is checking the server. This often passes after a while.",
    "busy" to "The server is playing its maximum number of videos.",
    "network" to "The server could not reach YouTube.",
)

/** True when retrying (or waiting) will not make this video playable, so a player that moves through videos (TV) should skip it. */
fun isSkippable(code: String?): Boolean = code in SKIPPABLE

/** What an error screen offers: whether to show Retry and an optional line explaining the wait. */
data class ErrorActions(val showRetry: Boolean, val hint: String?)

/**
 * Skippable codes get no Retry; rate-limit style codes get Retry with an explanation. A code this app doesn't know
 * (a newer server) follows the server's own [retryable] flag; no code at all (an older server, a local failure) keeps a plain Retry.
 */
fun errorActions(code: String?, retryable: Boolean = true): ErrorActions = when {
    code == null -> ErrorActions(showRetry = true, hint = null)
    isSkippable(code) -> ErrorActions(showRetry = false, hint = null)
    code in RETRY_WITH_HINT -> ErrorActions(showRetry = true, hint = RETRY_WITH_HINT[code])
    else -> ErrorActions(showRetry = retryable, hint = null)
}

/** True when the playback screen should mount the player: playable videos, a "Try anyway" override, or a hint without a reason. */
fun showPlayer(playable: Boolean, reason: String?, override: Boolean): Boolean = playable || override || reason == null

private const val MAX_MESSAGE = 200

/** A server message cut to a length that fits an error view. */
fun shortMessage(message: String): String = if (message.length > MAX_MESSAGE) message.take(MAX_MESSAGE - 1) + "\u2026" else message

/** The `{error, code, retryable}` body of an error response, or null when it isn't that JSON or has no message. */
fun errorBodyOf(body: String): ApiError? =
    runCatching { ApiJson.decodeFromString<ApiError>(body) }.getOrNull()?.takeIf { it.error.isNotBlank() }

/** Builds the exception for an error response body; a body that isn't the error JSON falls back to the status. */
fun apiErrorFrom(httpCode: Int, body: String): ApiException {
    val e = errorBodyOf(body)
    return ApiException(
        e?.error?.let(::shortMessage) ?: "Request failed ($httpCode)",
        code = e?.code?.ifBlank { null },
        retryable = e?.retryable ?: false,
    )
}

/**
 * Whether ExoPlayer should retry a failed /stream open. A 4xx never changes on retry, and a 5xx whose body carries a
 * classified error already says what is wrong (and retrying would re-hit a rate-limited server); a bare 5xx
 * (a proxy blip) keeps the default retries.
 */
fun retryStreamStatus(httpCode: Int, body: String): Boolean = when {
    httpCode in 400..499 -> false
    httpCode >= 500 -> errorBodyOf(body)?.code.isNullOrBlank()
    else -> true
}
