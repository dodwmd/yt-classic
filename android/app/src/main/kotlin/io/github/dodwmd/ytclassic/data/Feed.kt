package io.github.dodwmd.ytclassic.data

import kotlinx.coroutines.CancellationException

/** What the home feed is filtered by. The channel is for this visit only; the three toggles are saved on the server. */
data class FeedFilter(val channel: String? = null, val hideWatched: Boolean = false, val hideShorts: Boolean = false, val hideLive: Boolean = false) {
    /** The query for api/feed: always explicit, so the screen and the server can never disagree about a saved preference. */
    fun query(): List<Pair<String, String?>> = listOf(
        "channel" to channel,
        "hideWatched" to if (hideWatched) "1" else "0",
        "shorts" to if (hideShorts) "hide" else "show",
        "live" to if (hideLive) "hide" else "show",
    )

    fun prefs() = FeedPrefs(hideWatched, if (hideShorts) "hide" else "show", if (hideLive) "hide" else "show")

    companion object {
        fun of(prefs: FeedPrefs) = FeedFilter(null, prefs.hideWatched, prefs.shorts == "hide", prefs.live == "hide")
    }
}

/** What the Home feed shows right now. */
data class FeedState(
    val filter: FeedFilter = FeedFilter(),
    val items: List<FeedItem> = emptyList(),
    val next: String? = null,
    /** A request is in flight: the controls stay put, but a second tap does nothing. */
    val busy: Boolean = false,
    val error: String? = null,
)

/**
 * Feed state transitions, one request at a time: "load more" while another request is running does nothing, and a
 * filter change makes any older response (still in flight) irrelevant. Pure Kotlin so the JVM tests drive it directly.
 */
class FeedPager(private val api: YtApi) {
    private var generation = 0

    /**
     * Applies [filter] and loads its first page; if that fails the previous filter and items stay (with the error).
     * Returns the new state, or null when a newer request superseded this one.
     */
    suspend fun refresh(state: FeedState, filter: FeedFilter, publish: (FeedState) -> Unit): FeedState? {
        val mine = ++generation
        publish(state.copy(filter = filter, busy = true, error = null))
        return finish(mine, state, publish, { api.feed(filter) }) { page -> FeedState(filter, dedupe(emptyList(), page.items), page.next) }
    }

    /** Loads the page after [FeedState.next]; nothing happens without a cursor or while a request is running. */
    suspend fun more(state: FeedState, publish: (FeedState) -> Unit): FeedState? {
        val cursor = state.next ?: return null
        if (state.busy) return null
        val mine = ++generation
        publish(state.copy(busy = true, error = null))
        return finish(mine, state, publish, { api.feed(state.filter, cursor) }) { page -> state.copy(items = dedupe(state.items, page.items), next = page.next, busy = false, error = null) }
    }

    // Duplicate ids would crash the list (they are its keys), so drop any the server sends.
    private fun dedupe(have: List<FeedItem>, more: List<FeedItem>): List<FeedItem> {
        val seen = have.mapTo(HashSet()) { it.id }
        return have + more.filter { seen.add(it.id) }
    }

    private suspend fun finish(mine: Int, before: FeedState, publish: (FeedState) -> Unit, load: suspend () -> FeedPage, ok: (FeedPage) -> FeedState): FeedState? {
        val result = try {
            ok(load())
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiException) {
            before.copy(busy = false, error = e.message ?: "Request failed.")
        }
        if (mine != generation) return null
        publish(result)
        return result
    }
}
