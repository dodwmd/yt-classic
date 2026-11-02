package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import android.util.Log
import android.widget.Toast
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.dodwmd.ytclassic.data.errorActions
import io.github.dodwmd.ytclassic.data.SearchPage
import io.github.dodwmd.ytclassic.data.webLinks
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.ChannelAbout
import io.github.dodwmd.ytclassic.data.ChannelPlaylist
import io.github.dodwmd.ytclassic.data.Chunk
import io.github.dodwmd.ytclassic.data.PageState
import io.github.dodwmd.ytclassic.data.VideoSummary
import io.github.dodwmd.ytclassic.data.YtApi
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** A lazily loaded, paged list. [load] fetches the next page and ignores calls while a request is running. */
class PagedList<T>(
    private val scope: CoroutineScope,
    val idOf: (T) -> String,
    initial: PageState<T> = PageState(),
    private val fetch: suspend (String?) -> Chunk<T>,
) {
    var state by mutableStateOf(initial)
        private set

    fun load() {
        if (state.loading) return
        state = state.begin()
        val running = state
        scope.launch { state = running.advance(idOf, { Log.e("YtClassic", "channel tab load failed", it) }, fetch) }
    }
}

/**
 * What a channel screen has loaded, kept by the back stack entry: a round trip to a video (or a rotation) finds every tab
 * as it was. After process death the entry is restored but this is not, so tabs reload (from the server's cache); the
 * selected tab and scroll positions are saved by the screen itself.
 */
class ChannelModel(private val api: YtApi, private val id: String) : ViewModel() {
    private var firstUploads: PagedList<VideoSummary>? = null
    fun uploads(first: SearchPage) = firstUploads ?: PagedList(viewModelScope, { v: VideoSummary -> v.id }, PageState(first.items, first.nextPageToken, started = true)) { t ->
        api.channel(id, t).page.let { Chunk(it.items, it.nextPageToken) }
    }.also { firstUploads = it }
    val playlists = PagedList(viewModelScope, { p: ChannelPlaylist -> p.id }) { t -> api.channelPlaylists(id, t).let { Chunk(it.items, it.nextPageToken) } }
    val shorts = PagedList(viewModelScope, { v: VideoSummary -> v.id }) { t -> api.channelTab(id, "shorts", t).let { Chunk(it.items, it.nextPageToken) } }
    val live = PagedList(viewModelScope, { v: VideoSummary -> v.id }) { t -> api.channelTab(id, "live", t).let { Chunk(it.items, it.nextPageToken) } }
    val about = PagedList(viewModelScope, { a: ChannelAbout -> a.id }) { Chunk(listOf(api.channelAbout(id)), null) }
}

private val TAB_NAMES = listOf("Videos", "Playlists", "Shorts", "Live", "About")

@Composable
fun ChannelScreen(api: YtApi, id: String, onVideo: (String) -> Unit, onPlaylist: (String) -> Unit, onSubscribed: (String, Boolean) -> Unit = { _, _ -> }) {
    val model = viewModel<ChannelModel>(key = "channel:$id", factory = viewModelFactory { initializer { ChannelModel(api, id) } })
    // Above the load, so a Retry of a failed header load keeps the tab; saved across rotation and process death.
    var tab by rememberSaveable(id) { mutableIntStateOf(0) }
    val listStates = TAB_NAMES.map { rememberLazyListState() } // one scroll position per tab
    val loaded = rememberLoad(id) { api.channel(id) }
    LoadedContent(loaded) { c ->
        var subscribed by remember(c) { mutableStateOf(c.subscribed) }
        var busy by remember(c) { mutableStateOf(false) }
        var failure by remember(c) { mutableStateOf<String?>(null) }
        val scope = rememberCoroutineScope()
        val uploads = model.uploads(c.page)
        val pages = listOf(uploads, model.playlists, model.shorts, model.live, model.about)
        val keys = listOf("v", "p", "s", "l", "a")
        LaunchedEffect(tab) {
            val p = pages[tab]
            if (!p.state.started && !p.state.loading && p.state.error == null) p.load()
        }
        val videoItems = if (tab == 0) uploads.state.items else if (tab == 2) model.shorts.state.items else if (tab == 3) model.live.state.items else emptyList()
        val watched = rememberWatched(api, videoItems.map { it.id })
        val later = rememberLater(api, videoItems.map { it.id })
        Column {
            Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(c.channel.title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
                    c.channel.subscribers?.toLongOrNull()?.let { Text("%,d subscribers".format(it), color = Muted) }
                }
                Button(enabled = !busy, onClick = {
                    busy = true
                    scope.launch {
                        try {
                            subscribed = api.setSubscribed(c.channel.id, !subscribed)
                            onSubscribed(c.channel.id, subscribed)
                            failure = null
                        } catch (e: ApiException) {
                            failure = e.message
                        } finally {
                            busy = false
                        }
                    }
                }) { Text(if (subscribed) "Unsubscribe" else "Subscribe") }
            }
            failure?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp).semantics { liveRegion = LiveRegionMode.Polite }) }
            // Always visible above the list. Tab semantics (role and selected state) come from Material's Tab; its minimum height is 48dp.
            PrimaryScrollableTabRow(selectedTabIndex = tab, edgePadding = 0.dp) {
                TAB_NAMES.forEachIndexed { i, name ->
                    Tab(selected = tab == i, onClick = { tab = i }, text = { Text(name) })
                }
            }
            LazyColumn(state = listStates[tab], contentPadding = PaddingValues(bottom = 24.dp)) {
                when (tab) {
                    1 -> pagedRows(model.playlists, keys[tab], "No public playlists.") { p -> PlaylistRow(p) { onPlaylist(p.id) } }
                    4 -> pagedRows(model.about, keys[tab], "Nothing to show.") { a -> AboutContent(a) }
                    else -> {
                        val list = if (tab == 0) uploads else if (tab == 2) model.shorts else model.live
                        pagedRows(list, keys[tab], if (tab == 2) "No Shorts." else if (tab == 3) "No live streams." else "No uploads.") { v -> SummaryRow(v, onVideo, v.id in watched, later) }
                    }
                }
            }
        }
    }
}

/** The rows of [list] followed by its footer: spinner, error with Retry (and Open Settings for a token problem), "Load more", or the empty note. */
private fun <T> LazyListScope.pagedRows(list: PagedList<T>, prefix: String, empty: String, row: @Composable (T) -> Unit) {
    val s = list.state
    items(s.items.size, key = { "$prefix:${list.idOf(s.items[it])}" }, contentType = { prefix }) { row(s.items[it]) }
    item(key = "$prefix:footer", contentType = "footer") {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (s.loading) CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading" })
            s.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                if (s.needsToken) {
                    val openSettings = LocalOpenSettings.current
                    Button(onClick = openSettings) { Text("Open Settings") }
                }
                val actions = errorActions(s.code, s.retryable)
                actions.hint?.let { Text(it, color = Muted) }
                if (actions.showRetry) OutlinedButton(onClick = { list.load() }, enabled = !s.loading) { Text("Retry") }
            }
            if (s.canLoadMore && s.error == null) OutlinedButton(onClick = { list.load() }) { Text("Load more") }
            // Only the end of the list is "nothing": a scan that found no match so far still has a next page to try.
            if (s.started && s.items.isEmpty() && s.error == null && s.token == null && !s.loading) Text(empty, color = Muted)
        }
    }
}

@Composable
private fun PlaylistRow(p: ChannelPlaylist, onClick: () -> Unit) = VideoRow(
    thumb = p.thumb, title = p.title, duration = null, onClick = onClick,
    details = listOf(p.itemCount?.let { "$it video${if (it == 1) "" else "s"}" }.orEmpty()),
)

@Composable
private fun AboutContent(a: ChannelAbout) {
    val uri = LocalUriHandler.current
    val context = LocalContext.current
    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SelectionContainer { Text(a.description.ifBlank { "No description." }) }
        val facts = listOf(
            "Handle" to a.customUrl,
            "Joined" to a.publishedAt?.take(10),
            "Country" to a.country,
            "Views" to a.viewCount?.toLongOrNull()?.let { "%,d".format(it) },
            "Subscribers" to a.subscriberCount?.toLongOrNull()?.let { "%,d".format(it) },
            "Videos" to a.videoCount,
        )
        for ((k, v) in facts) if (!v.isNullOrBlank()) {
            Row(Modifier.semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(k, color = Muted, modifier = Modifier.weight(0.4f))
                Text(v, modifier = Modifier.weight(0.6f))
            }
        }
        for (link in webLinks(a.links)) {
            Text(
                link, color = LinkBlue,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .clickable(role = Role.Button, onClickLabel = "Open $link") {
                        try {
                            uri.openUri(link)
                        } catch (_: Exception) { // no app to open it, or the system refused
                            Toast.makeText(context, "Can't open this link", Toast.LENGTH_SHORT).show()
                        }
                    }
                    .padding(vertical = 12.dp),
            )
        }
    }
}

/** What one channel playlist screen has loaded; see [ChannelModel]. */
class ChannelPlaylistModel(private val api: YtApi, private val id: String, private val playlistId: String) : ViewModel() {
    private var list: PagedList<VideoSummary>? = null
    fun videos(first: SearchPage) = list ?: PagedList(viewModelScope, { v: VideoSummary -> v.id }, PageState(first.items, first.nextPageToken, started = true)) { t ->
        api.channelPlaylist(id, playlistId, t).page.let { Chunk(it.items, it.nextPageToken) }
    }.also { list = it }
}

/** One of the channel's playlists: its videos (Load more for the rest). Nothing plays on its own. */
@Composable
fun ChannelPlaylistScreen(api: YtApi, id: String, playlistId: String, onVideo: (String) -> Unit) {
    val model = viewModel<ChannelPlaylistModel>(key = "channel:$id:$playlistId", factory = viewModelFactory { initializer { ChannelPlaylistModel(api, id, playlistId) } })
    val listState = rememberLazyListState()
    val first = rememberLoad(id, playlistId) { api.channelPlaylist(id, playlistId) }
    LoadedContent(first) { r ->
        val list = model.videos(r.page)
        val items = list.state.items
        val watched = rememberWatched(api, items.map { it.id })
        val later = rememberLater(api, items.map { it.id })
        LazyColumn(state = listState, contentPadding = PaddingValues(bottom = 24.dp)) {
            item { SectionTitle(r.playlist.title) }
            pagedRows(list, "pl", "This playlist has no videos you can see.") { v -> SummaryRow(v, onVideo, v.id in watched, later) }
        }
    }
}
