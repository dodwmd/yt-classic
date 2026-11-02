package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.AuthException
import io.github.dodwmd.ytclassic.data.ChannelHit
import io.github.dodwmd.ytclassic.data.DurationFilter
import io.github.dodwmd.ytclassic.data.RecentSearch
import io.github.dodwmd.ytclassic.data.SearchHolder
import io.github.dodwmd.ytclassic.data.SortFilter
import io.github.dodwmd.ytclassic.data.Suggester
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.errorActions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

/** A failure with, when the cause is the access token, the way out (as in the Watch later notes). */
class Failure(val message: String, val needsToken: Boolean = false, val hint: String? = null)

/** The server's own message (classified errors carry one), the way out for a token problem and the wait hint for rate limits. */
fun failureOf(e: ApiException) = Failure(e.message ?: "Request failed.", e is AuthException, errorActions(e.code, e.retryable).hint)

@Composable
private fun FailureNote(f: Failure, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(f.message, color = MaterialTheme.colorScheme.error, fontSize = 12.sp)
        f.hint?.let { Text(it, color = Muted, fontSize = 12.sp) }
        if (f.needsToken) TextButton(onClick = LocalOpenSettings.current) { Text("Open Settings") }
    }
}

@Composable
fun SearchScreen(api: YtApi, holder: SearchHolder, query: String, onVideo: (String) -> Unit, onChannel: (String) -> Unit) {
    var channels by rememberSaveable(query) { mutableStateOf(false) }
    var duration by rememberSaveable(query) { mutableStateOf(DurationFilter.Any) }
    var sort by rememberSaveable(query) { mutableStateOf(SortFilter.Relevance) }
    Column {
        LazyRow(contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            item { FilterChip(selected = !channels, onClick = { channels = false }, label = { Text("Videos") }) }
            item { FilterChip(selected = channels, onClick = { channels = true }, label = { Text("Channels") }) }
            if (!channels) {
                items(DurationFilter.entries) { d -> FilterChip(selected = duration == d, onClick = { duration = d }, label = { Text(d.label) }) }
                items(SortFilter.entries.drop(1)) { s ->
                    // Tapping the active sort again goes back to relevance.
                    FilterChip(selected = sort == s, onClick = { sort = if (sort == s) SortFilter.Relevance else s }, label = { Text("Sort: ${s.label}") })
                }
            }
        }
        Box(Modifier.weight(1f)) {
            if (channels) ChannelResults(api, holder, query, onChannel) else VideoResults(api, holder, query, duration, sort, onVideo)
        }
    }
}

@Composable
private fun Notes(notes: List<String>) {
    for (n in notes) Text(n, color = Muted, fontSize = 12.sp, modifier = Modifier.padding(horizontal = 12.dp, vertical = 2.dp))
}

@Composable
private fun VideoResults(api: YtApi, holder: SearchHolder, query: String, duration: DurationFilter, sort: SortFilter, onVideo: (String) -> Unit) {
    val key = holder.videoKey(query, duration, sort)
    val first = rememberLoad(key) { holder.videos(key) ?: api.search(query, null, duration.param, sort.param).also { holder.putVideos(key, it) } }
    LoadedContent(first) { page ->
        // Duplicate ids would crash the list (they are its keys), so drop any the server sends.
        var items by remember(page) { mutableStateOf(page.items.distinctBy { it.id }) }
        var token by remember(page) { mutableStateOf(page.nextPageToken) }
        var failure by remember(page) { mutableStateOf<Failure?>(null) }
        var loading by remember(page) { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        val watched = rememberWatched(api, items.map { it.id })
        val later = rememberLater(api, items.map { it.id })
        LazyColumn(state = holder.state("v|$key") { LazyListState() }, contentPadding = PaddingValues(bottom = 24.dp)) {
            item { SectionTitle("Results for \"$query\"") }
            item { Notes(page.notes) }
            if (items.isEmpty()) item { Text("No results.", modifier = Modifier.padding(12.dp)) }
            items(items, key = { it.id }) { SummaryRow(it, onVideo, it.id in watched, later) }
            item {
                Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    failure?.let { FailureNote(it) }
                    if (token != null) {
                        OutlinedButton(enabled = !loading, onClick = {
                            loading = true
                            scope.launch {
                                try {
                                    val next = api.search(query, token, duration.param, sort.param)
                                    items = items + next.items.filter { n -> items.none { it.id == n.id } }
                                    token = next.nextPageToken
                                    failure = null
                                    holder.putVideos(key, page.copy(items = items, nextPageToken = token, prevPageToken = null))
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: ApiException) {
                                    failure = failureOf(e)
                                } finally {
                                    loading = false
                                }
                            }
                        }) { Text("Load more") }
                    }
                }
            }
        }
    }
}

@Composable
private fun ChannelResults(api: YtApi, holder: SearchHolder, query: String, onChannel: (String) -> Unit) {
    val key = query
    val first = rememberLoad(key) { holder.channels(key) ?: api.searchChannels(query).also { holder.putChannels(key, it) } }
    LoadedContent(first) { page ->
        var items by remember(page) { mutableStateOf(page.channels.distinctBy { it.id }) }
        var token by remember(page) { mutableStateOf(page.nextPageToken) }
        var failure by remember(page) { mutableStateOf<Failure?>(null) }
        var loading by remember(page) { mutableStateOf(false) }
        // Subscribe state lives here, above the list: a row that scrolls out of sight must not forget it or a request in flight.
        var subs by remember(page) { mutableStateOf(emptyMap<String, Boolean>()) }
        var busy by remember(page) { mutableStateOf(emptySet<String>()) }
        var errors by remember(page) { mutableStateOf(emptyMap<String, Failure>()) }
        val scope = rememberCoroutineScope()
        val toggle = { c: ChannelHit ->
            if (c.id !in busy) {
                val now = subs[c.id] ?: holder.subscribed(c.id) ?: c.subscribed
                busy = busy + c.id
                scope.launch {
                    try {
                        val after = api.setSubscribed(c.id, !now)
                        subs = subs + (c.id to after)
                        holder.setSubscribed(c.id, after)
                        errors = errors - c.id
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: ApiException) {
                        errors = errors + (c.id to failureOf(e))
                    } finally {
                        busy = busy - c.id
                    }
                }
            }
        }
        LazyColumn(state = holder.state("c|$key") { LazyListState() }, contentPadding = PaddingValues(bottom = 24.dp)) {
            item { SectionTitle("Channels for \"$query\"") }
            item { Notes(page.notes) }
            if (items.isEmpty()) item { Text("No channels found.", modifier = Modifier.padding(12.dp)) }
            items(items, key = { it.id }) { c ->
                ChannelRow(c, subs[c.id] ?: holder.subscribed(c.id) ?: c.subscribed, c.id in busy, errors[c.id], { toggle(c) }, onChannel)
            }
            item {
                Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    failure?.let { FailureNote(it) }
                    if (token != null) {
                        OutlinedButton(enabled = !loading, onClick = {
                            loading = true
                            scope.launch {
                                try {
                                    val next = api.searchChannels(query, token)
                                    items = items + next.channels.filter { n -> items.none { it.id == n.id } }
                                    token = next.nextPageToken
                                    failure = null
                                    holder.putChannels(key, page.copy(channels = items, nextPageToken = token))
                                } catch (e: CancellationException) {
                                    throw e
                                } catch (e: ApiException) {
                                    failure = failureOf(e)
                                } finally {
                                    loading = false
                                }
                            }
                        }) { Text("Load more") }
                    }
                }
            }
        }
    }
}

/** A channel in the results: tap to open it; the button subscribes or unsubscribes. State comes from the list, so it survives scrolling. */
@Composable
fun ChannelRow(c: ChannelHit, subscribed: Boolean, busy: Boolean, failure: Failure?, onToggle: () -> Unit, onOpen: (String) -> Unit) {
    Column {
        Row(
            Modifier.fillMaxWidth().clickable(onClickLabel = "Open channel ${c.title}", role = Role.Button) { onOpen(c.id) }.padding(horizontal = 12.dp, vertical = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Box(Modifier.size(56.dp).clip(CircleShape).background(Muted.copy(alpha = 0.25f))) {
                if (c.thumb.startsWith("https://")) AsyncImage(model = c.thumb, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
            }
            Column(Modifier.weight(1f)) {
                Text(c.title, color = LinkBlue, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                Text(channelDetails(c), color = Muted, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (c.description.isNotBlank()) Text(c.description, fontSize = 12.sp, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            val action = if (subscribed) "Unsubscribe" else "Subscribe"
            val modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "$action ${c.title}" }
            if (subscribed) OutlinedButton(onClick = onToggle, enabled = !busy, modifier = modifier) { Text(action) }
            else Button(onClick = onToggle, enabled = !busy, modifier = modifier) { Text(action) }
        }
        failure?.let { FailureNote(it, Modifier.padding(horizontal = 78.dp)) }
    }
}

/** "@handle · 1,234 subscribers" with whatever is known. */
fun channelDetails(c: ChannelHit): String = listOfNotNull(c.handle, c.subscribers?.toLongOrNull()?.let { "%,d subscribers".format(it) }).joinToString(" · ")

/** The recent searches as the search panel knows them: loaded when first needed, again after a search, not on every focus. */
class RecentState(private val api: YtApi) {
    var list by mutableStateOf<List<RecentSearch>>(emptyList())
        private set
    private var stale = true
    private var loading = false

    /** A search was made: the server has a new entry, so ask again next time. */
    fun invalidate() {
        stale = true
    }

    suspend fun refresh() {
        if (!stale || loading) return
        loading = true
        try {
            list = api.recentSearches()
            stale = false
        } catch (e: CancellationException) {
            throw e
        } catch (_: ApiException) {
            // no list is better than an error in the way of typing; the next focus tries again
        } finally {
            loading = false
        }
    }

    suspend fun remove(id: Long) {
        api.removeRecentSearch(id)
        list = list.filter { it.id != id }
    }

    suspend fun clear() {
        api.clearRecentSearches()
        list = emptyList()
    }
}

/**
 * Drawn over the screen (not part of the top bar, so the content does not jump) while the search box has focus: your
 * recent searches when it is empty (Clear all, and a remove button per entry), YouTube's suggestions (asked through the
 * server) while typing. [maxHeight] keeps it above the keyboard.
 */
@Composable
fun SearchPanel(api: YtApi, recent: RecentState, query: String, maxHeight: Dp, modifier: Modifier = Modifier, onPick: (String) -> Unit) {
    var suggestions by remember { mutableStateOf("" to emptyList<String>()) }
    var busy by remember { mutableStateOf(false) }
    var failure by remember { mutableStateOf<Failure?>(null) }
    val scope = rememberCoroutineScope()
    val suggester = remember { Suggester(scope, { api.suggest(it) }, { q, list -> suggestions = q to list }) }
    LaunchedEffect(Unit) { recent.refresh() }
    LaunchedEffect(query) { suggester.input(query) }
    val typed = query.trim()
    val shown = if (typed.isEmpty()) recent.list.map { it.query } else suggestions.second.takeIf { suggestions.first == typed }.orEmpty()
    if (shown.isEmpty() && failure == null) return
    val run = { block: suspend () -> Unit ->
        busy = true
        scope.launch {
            try {
                block()
                failure = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                failure = failureOf(e)
            } finally {
                busy = false
            }
        }
    }
    Column(modifier.fillMaxWidth().heightIn(max = maxHeight).background(Masthead).verticalScroll(rememberScrollState()).semantics { liveRegion = LiveRegionMode.Polite }) {
        if (typed.isEmpty()) {
            Row(Modifier.fillMaxWidth().padding(start = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Recent searches", color = Muted, fontSize = 12.sp, modifier = Modifier.weight(1f).semantics { heading() })
                TextButton(enabled = !busy, modifier = Modifier.heightIn(min = 48.dp), onClick = { run { recent.clear() } }) { Text("Clear all") }
            }
        }
        failure?.let { FailureNote(it, Modifier.padding(horizontal = 12.dp)) }
        for (text in shown) {
            val entry = recent.list.firstOrNull { it.query == text }.takeIf { typed.isEmpty() }
            Row(
                Modifier.fillMaxWidth().clickable(onClickLabel = "Search for $text", role = Role.Button) { onPick(text) }.heightIn(min = 48.dp).padding(start = 12.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(text, color = Classic.logoText, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                if (entry != null) {
                    TextButton(enabled = !busy, modifier = Modifier.heightIn(min = 48.dp).semantics { contentDescription = "Remove $text from recent searches" }, onClick = { run { recent.remove(entry.id) } }) {
                        Text("✕", color = Muted)
                    }
                }
            }
        }
    }
}
