package io.github.dodwmd.ytclassic.data

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlin.coroutines.cancellation.CancellationException

/** The duration filter: the value sent to the server and the label shown. Short < 4 min, medium 4-20 min, long > 20 min. */
enum class DurationFilter(val param: String, val label: String) {
    Any("any", "Any length"),
    Short("short", "Under 4 min"),
    Medium("medium", "4 to 20 min"),
    Long("long", "Over 20 min"),
}

enum class SortFilter(val param: String, val label: String) {
    Relevance("relevance", "Relevance"),
    Date("date", "Upload date"),
    Views("views", "View count"),
}

/**
 * Suggestions as the user types: waits [delayMs] after the last keystroke, and a newer keystroke cancels the request in
 * flight. [onResult] gets the text the answer belongs to, so a late answer can never be shown for different text; a
 * failure is reported as an empty list for that text.
 */
class Suggester(
    private val scope: CoroutineScope,
    private val fetch: suspend (String) -> List<String>,
    private val onResult: (query: String, suggestions: List<String>) -> Unit,
    private val delayMs: Long = 250,
    private val sleep: suspend (Long) -> Unit = { delay(it) },
) {
    private var job: Job? = null

    /** Call on every change of the text. Blank text just cancels (the caller shows recent searches then). */
    fun input(text: String) {
        job?.cancel()
        val q = text.trim()
        if (q.isEmpty()) return
        job = scope.launch {
            sleep(delayMs)
            val found = try {
                fetch(q).take(MAX)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                emptyList()
            }
            onResult(q, found)
        }
    }

    fun cancel() {
        job?.cancel()
    }

    companion object {
        const val MAX = 8
    }
}

/**
 * Search results kept for the session, so coming back from a channel (or flipping Videos/Channels/filters back) shows the
 * same pages and scroll position instead of loading again. Least recently used entries go first. Plain Kotlin.
 */
class SearchHolder(private val max: Int = 8) {
    private val videos = LinkedHashMap<String, SearchPage>()
    private val channels = LinkedHashMap<String, ChannelSearchPage>()
    private val states = LinkedHashMap<String, Any>()
    private val subscribed = HashMap<String, Boolean>()

    fun videoKey(query: String, duration: DurationFilter, sort: SortFilter) = "$query|${duration.param}|${sort.param}"

    fun videos(key: String): SearchPage? = touch(videos, key)
    fun putVideos(key: String, page: SearchPage) = put(videos, key, page)
    fun channels(key: String): ChannelSearchPage? = touch(channels, key)
    fun putChannels(key: String, page: ChannelSearchPage) = put(channels, key, page)

    /** One value per key and kind (e.g. the list's scroll state), created on first use. */
    @Suppress("UNCHECKED_CAST")
    fun <S : Any> state(key: String, create: () -> S): S {
        val old = states.remove(key)
        val value = (old as S?) ?: create()
        states[key] = value
        while (states.size > max * 2) states.remove(states.keys.first())
        return value
    }

    /** The user's own subscribe/unsubscribe for [id] in this session (it beats what a cached page said). */
    fun subscribed(id: String): Boolean? = subscribed[id]
    fun setSubscribed(id: String, value: Boolean) {
        subscribed[id] = value
    }

    private fun <T> touch(map: LinkedHashMap<String, T>, key: String): T? = map.remove(key)?.also { map[key] = it }
    private fun <T> put(map: LinkedHashMap<String, T>, key: String, value: T) {
        map.remove(key)
        map[key] = value
        while (map.size > max) map.remove(map.keys.first())
    }
}
