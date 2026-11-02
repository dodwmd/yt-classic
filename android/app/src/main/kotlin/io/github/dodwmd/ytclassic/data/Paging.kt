package io.github.dodwmd.ytclassic.data

import kotlinx.coroutines.CancellationException

/** One page from the server: the items and the token for the next one (null at the end). */
data class Chunk<T>(val items: List<T>, val next: String?)

/**
 * A list that is loaded lazily and page by page. Plain data, so the rules are testable without a UI: the caller flips
 * [loading] on before it starts a request (and ignores taps while it is on, which is the in-flight guard) and
 * replaces the state with the result of [advance]. Only the first page is ever empty-handed: "nothing here" is shown only
 * when the server says there is no next page either.
 */
data class PageState<T>(
    val items: List<T> = emptyList(),
    val token: String? = null,
    val started: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
    /** The failure was the access token: the footer offers Open Settings next to Retry. */
    val needsToken: Boolean = false,
    /** The server's classified error code (private, rate-limited, ...) and retry flag, for [errorActions]. */
    val code: String? = null,
    val retryable: Boolean = true,
) {
    /** "Load more" is offered once the first page is in, there is a next one and nothing is running. */
    val canLoadMore: Boolean get() = started && token != null && !loading

    /** The state that the caller shows while a request is running. */
    fun begin(): PageState<T> = copy(loading = true, error = null, needsToken = false, code = null, retryable = true)

    /**
     * Fetches the next page (the first one when not [started]). A failure keeps what is shown and the token, so the
     * same control retries; items already shown (by [idOf]) are not added twice.
     */
    suspend fun advance(idOf: (T) -> String, onUnexpected: (Exception) -> Unit = {}, fetch: suspend (String?) -> Chunk<T>): PageState<T> =
        try {
            val chunk = fetch(if (started) token else null)
            val seen = items.mapTo(HashSet(), idOf)
            copy(items = items + chunk.items.filter { seen.add(idOf(it)) }, token = chunk.next, started = true, loading = false, error = null, needsToken = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            copy(loading = false, error = e.message ?: "Something went wrong.", needsToken = e is AuthException, code = e.code, retryable = e.retryable)
        } catch (e: Exception) {
            // Anything else is a bug or a surprise: the user gets a generic message (and can retry), the caller gets the details.
            onUnexpected(e)
            copy(loading = false, error = "Something went wrong.", needsToken = false)
        }
}
