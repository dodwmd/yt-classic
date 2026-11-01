package io.github.dodwmd.ytclassic.data

import androidx.compose.foundation.lazy.LazyListState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

sealed interface HomeState {
    data object Loading : HomeState
    data class Error(val error: ApiException) : HomeState
    data class Ready(val home: HomeResponse, val pager: FeedPager) : HomeState
}

/**
 * The Home screen's state, kept outside the screen so Back from a video returns to the same list: the pages loaded with
 * "Load more", the scroll position and the channel filter. Opening Home again reloads in the background only when the
 * data is older than [staleAfterMs] or the server or token changed; the screen never goes back to a spinner for that.
 */
class HomeFeed(val api: YtApi, private val scope: CoroutineScope, private val staleAfterMs: Long = 5 * 60_000, private val now: () -> Long = System::currentTimeMillis) {
    private val flow = MutableStateFlow<HomeState>(HomeState.Loading)
    val state: StateFlow<HomeState> = flow
    val listState = LazyListState()
    private var key: String? = null
    private var loadedAt = 0L
    private var job: Job? = null

    /** Called when Home is shown; [connection] identifies the server and token in use. */
    fun enter(connection: String) {
        if (connection != key) {
            key = connection
            load(background = false)
        } else if (flow.value is HomeState.Error) {
            load(background = false)
        } else if (now() - loadedAt > staleAfterMs && job?.isActive != true) {
            load(background = true)
        }
    }

    fun retry() = load(background = false)

    /** Waits for a running load (tests). */
    suspend fun idle() = job?.join()

    private fun load(background: Boolean) {
        job?.cancel()
        if (!background) flow.value = HomeState.Loading
        job = scope.launch {
            try {
                val home = api.home()
                loadedAt = now()
                val old = flow.value
                val first = FeedState(FeedFilter.of(home.prefs), home.feed.distinctBy { it.id }, home.next)
                // A refresh in the background keeps what the user is looking at once they have paged or filtered.
                flow.value = if (background && old is HomeState.Ready && !old.pager.pristine) old.copy(home = home) else {
                    listState.requestScrollToItem(0)
                    HomeState.Ready(home, FeedPager(api, scope, first))
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                if (!background) flow.value = HomeState.Error(e)
            }
        }
    }
}
