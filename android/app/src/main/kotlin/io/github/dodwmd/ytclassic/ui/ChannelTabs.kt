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
    private val idOf: (T) -> String,
    initial: PageState<T> = PageState(),
    private val fetch: suspend (String?) -> Chunk<T>,
) {
    var state by mutableStateOf(initial)
        private set

    fun load() {
        if (state.loading) return
        state = state.begin()
        val running = state
        scope.launch { state = running.advance(idOf, fetch) }
    }
}

@Composable
private fun <T> rememberPaged(vararg keys: Any?, idOf: (T) -> String, initial: PageState<T> = PageState(), fetch: suspend (String?) -> Chunk<T>): PagedList<T> {
    val scope = rememberCoroutineScope()
    return remember(*keys) { PagedList(scope, idOf, initial, fetch) }
}

private val TAB_NAMES = listOf("Videos", "Playlists", "Shorts", "Live", "About")

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelScreen(api: YtApi, id: String, onVideo: (String) -> Unit, onPlaylist: (String) -> Unit) {
    val loaded = rememberLoad(id) { api.channel(id) }
    LoadedContent(loaded) { c ->
        var subscribed by remember(c) { mutableStateOf(c.subscribed) }
        var busy by remember(c) { mutableStateOf(false) }
        var failure by remember(c) { mutableStateOf<String?>(null) }
        // Survives rotation and process death; each tab loads the first time it is opened and keeps its pages after that.
        var tab by rememberSaveable(id) { mutableIntStateOf(0) }
        val scope = rememberCoroutineScope()
        val videoId = { v: VideoSummary -> v.id }
        val uploads = rememberPaged(c, idOf = videoId, initial = PageState(c.page.items, c.page.nextPageToken, started = true)) { t ->
            api.channel(id, t).page.let { Chunk(it.items, it.nextPageToken) }
        }
        val playlists = rememberPaged(c, idOf = { p: ChannelPlaylist -> p.id }) { t -> api.channelPlaylists(id, t).let { Chunk(it.items, it.nextPageToken) } }
        val shorts = rememberPaged(c, idOf = videoId) { t -> api.channelTab(id, "shorts", t).let { Chunk(it.items, it.nextPageToken) } }
        val live = rememberPaged(c, idOf = videoId) { t -> api.channelTab(id, "live", t).let { Chunk(it.items, it.nextPageToken) } }
        val about = rememberPaged(c, idOf = { a: ChannelAbout -> a.id }) { Chunk(listOf(api.channelAbout(id)), null) }
        val videoLists = listOf(uploads, null, shorts, live, null)
        val current = videoLists[tab]
        LaunchedEffect(tab) {
            val p = when (tab) { 1 -> playlists; 2 -> shorts; 3 -> live; 4 -> about; else -> null }
            if (p != null && !p.state.started && !p.state.loading && p.state.error == null) p.load()
        }
        val videoItems = current?.state?.items.orEmpty()
        val watched = rememberWatched(api, videoItems.map { it.id })
        val later = rememberLater(api, videoItems.map { it.id })
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Row(Modifier.fillMaxWidth().padding(12.dp), horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(c.channel.title, style = MaterialTheme.typography.titleLarge)
                        c.channel.subscribers?.toLongOrNull()?.let { Text("%,d subscribers".format(it), color = Muted) }
                    }
                    Button(enabled = !busy, onClick = {
                        busy = true
                        scope.launch {
                            try {
                                subscribed = api.setSubscribed(c.channel.id, !subscribed)
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
                // Tab semantics (role and selected state) come from Material's Tab; its minimum height is 48dp.
                PrimaryScrollableTabRow(selectedTabIndex = tab, edgePadding = 0.dp) {
                    TAB_NAMES.forEachIndexed { i, name ->
                        Tab(selected = tab == i, onClick = { tab = i }, text = { Text(name) })
                    }
                }
            }
            when (tab) {
                1 -> {
                    pagedRows(playlists, "No public playlists.") { p -> PlaylistRow(p) { onPlaylist(p.id) } }
                }
                4 -> {
                    pagedRows(about, "Nothing to show.") { a -> AboutContent(a) }
                }
                else -> {
                    val list = current!!
                    pagedRows(list, if (tab == 2) "No Shorts." else if (tab == 3) "No live streams." else "No uploads.") { v -> SummaryRow(v, onVideo, v.id in watched, later) }
                }
            }
        }
    }
}

/** The rows of [list] followed by its footer: spinner, error with Retry, "Load more", or the empty note. */
private fun <T> LazyListScope.pagedRows(list: PagedList<T>, empty: String, row: @Composable (T) -> Unit) {
    val s = list.state
    items(s.items.size) { row(s.items[it]) }
    item(key = "footer") {
        Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            if (s.loading) CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading" })
            s.error?.let {
                Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                OutlinedButton(onClick = { list.load() }, enabled = !s.loading) { Text("Retry") }
            }
            if (s.canLoadMore && s.error == null) OutlinedButton(onClick = { list.load() }) { Text("Load more") }
            if (s.started && s.items.isEmpty() && s.error == null) Text(empty, color = Muted)
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
    Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(a.description.ifBlank { "No description." })
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
        for (link in a.links.filter { it.startsWith("https://") || it.startsWith("http://") }) {
            Text(
                link, color = LinkBlue,
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp)
                    .clickable(role = Role.Button, onClickLabel = "Open link") { runCatching { uri.openUri(link) } }
                    .padding(vertical = 12.dp),
            )
        }
    }
}

/** One of the channel's playlists: its videos (Load more for the rest). Nothing plays on its own. */
@Composable
fun ChannelPlaylistScreen(api: YtApi, id: String, playlistId: String, onVideo: (String) -> Unit) {
    val first = rememberLoad(id, playlistId) { api.channelPlaylist(id, playlistId) }
    LoadedContent(first) { r ->
        val list = rememberPaged(r, idOf = { v: VideoSummary -> v.id }, initial = PageState(r.page.items, r.page.nextPageToken, started = true)) { t ->
            api.channelPlaylist(id, playlistId, t).page.let { Chunk(it.items, it.nextPageToken) }
        }
        val items = list.state.items
        val watched = rememberWatched(api, items.map { it.id })
        val later = rememberLater(api, items.map { it.id })
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item { SectionTitle(r.playlist.title) }
            pagedRows(list, "This playlist has no videos you can see.") { v -> SummaryRow(v, onVideo, v.id in watched, later) }
        }
    }
}
