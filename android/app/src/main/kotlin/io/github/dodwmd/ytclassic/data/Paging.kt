package io.github.dodwmd.ytclassic.data

import kotlinx.coroutines.CancellationException

/** One page from the server: the items and the token for the next one (null at the end). */
data class Chunk<T>(val items: List<T>, val next: String?)

/**
 * A list that is loaded lazily and page by page. Plain data, so the rules are testable without a UI: the caller flips
 * [loading] on before it starts a request (and ignores taps while it is on, which is the in-flight guard) and
 * replaces the state with the result of [advance].
 */
data class PageState<T>(
    val items: List<T> = emptyList(),
    val token: String? = null,
    val started: Boolean = false,
    val loading: Boolean = false,
    val error: String? = null,
) {
    /** "Load more" is offered once the first page is in, there is a next one and nothing is running. */
    val canLoadMore: Boolean get() = started && token != null && !loading

    /** The state that the caller shows while a request is running. */
    fun begin(): PageState<T> = copy(loading = true, error = null)

    /**
     * Fetches the next page (the first one when not [started]). A failure keeps what is shown and the token, so the
     * same control retries; items already shown (by [idOf]) are not added twice.
     */
    suspend fun advance(idOf: (T) -> String, fetch: suspend (String?) -> Chunk<T>): PageState<T> =
        try {
            val chunk = fetch(if (started) token else null)
            val seen = items.mapTo(HashSet(), idOf)
            copy(items = items + chunk.items.filter { seen.add(idOf(it)) }, token = chunk.next, started = true, loading = false, error = null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            copy(loading = false, error = e.message ?: "Something went wrong.")
        }
}
