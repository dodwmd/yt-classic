package io.github.dodwmd.ytclassic.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

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
    /** The last request failed (the list and filter are those of the last success). Carries what the UI needs: [AuthException] means "open Settings". */
    val error: ApiException? = null,
    /** Saving the toggles on the server failed; they still apply to this visit. */
    val prefsError: String? = null,
)

/**
 * Owns the Home feed and its requests, one at a time. [state] always shows either the last successful list or that list
 * with a request in flight or an error: a failed request rolls back to the last success (never to a snapshot taken
 * while something else was running). A newer request cancels the older one; "Load more" does nothing while any request
 * runs or without a cursor. The toggles are saved on the server only after a refresh with them succeeded.
 * [scope] outlives the screen, so a request or save finishes even if the user briefly leaves Home.
 */
class FeedPager(private val api: YtApi, private val scope: CoroutineScope, initial: FeedState) {
    private val lock = Any()
    private val flow = MutableStateFlow(initial)
    val state: StateFlow<FeedState> = flow
    private var good = initial.copy(busy = false, error = null)
    private var job: Job? = null
    private var generation = 0
    private var lastAction: () -> Unit = {}
    private var savedPrefs = initial.filter.prefs()
    private var wantedPrefs = savedPrefs
    private var saving: Job? = null

    /** True until the user changes a filter or loads more: only then may a background refresh replace the list. */
    @Volatile var pristine = true
        private set

    /** Applies [filter] and loads its first page. */
    fun refresh(filter: FeedFilter): Unit = synchronized(lock) {
        pristine = false
        lastAction = { refresh(filter) }
        val mine = start(good.copy(filter = filter, busy = true, error = null))
        job = scope.launch {
            try {
                val page = api.feed(filter)
                finish(mine, FeedState(filter, dedupe(emptyList(), page.items), page.next, prefsError = good.prefsError))
                savePrefs(filter.prefs())
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                fail(mine, e)
            }
        }
    }

    /** Loads the page after the cursor of the last success. */
    fun more(): Unit = synchronized(lock) {
        val cursor = good.next ?: return
        if (flow.value.busy) return
        pristine = false
        lastAction = { more() }
        val base = good
        val mine = start(base.copy(busy = true, error = null))
        job = scope.launch {
            try {
                val page = api.feed(base.filter, cursor)
                finish(mine, base.copy(items = dedupe(base.items, page.items), next = page.next))
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                fail(mine, e)
            }
        }
    }

    /** Repeats the request that failed. */
    fun retry() = lastAction()

    /** Waits for the running request and save (tests). */
    suspend fun idle() {
        job?.join()
        saving?.join()
    }

    private fun start(busy: FeedState): Int {
        job?.cancel()
        flow.value = busy
        return ++generation
    }

    private fun finish(mine: Int, result: FeedState): Unit = synchronized(lock) {
        if (mine != generation) return
        good = result
        flow.value = result
    }

    private fun fail(mine: Int, e: ApiException): Unit = synchronized(lock) {
        if (mine != generation) return
        flow.value = good.copy(busy = false, error = e)
    }

    private fun savePrefs(prefs: FeedPrefs): Unit = synchronized(lock) {
        wantedPrefs = prefs
        if (prefs == savedPrefs && good.prefsError == null) return
        saving?.cancel()
        saving = scope.launch {
            try {
                savedPrefs = api.setPrefs(wantedPrefs) // what the server now has is what we remember
                update { it.copy(prefsError = null) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                update { it.copy(prefsError = "Couldn't save these filters on the server (${e.message}). They apply here only; changing one again retries.") }
            }
        }
    }

    private fun update(change: (FeedState) -> FeedState): Unit = synchronized(lock) {
        good = change(good)
        flow.value = change(flow.value)
    }

    // Duplicate ids would crash the list (they are its keys), so drop any the server sends.
    private fun dedupe(have: List<FeedItem>, more: List<FeedItem>): List<FeedItem> {
        val seen = have.mapTo(HashSet()) { it.id }
        return have + more.filter { seen.add(it.id) }
    }
}
