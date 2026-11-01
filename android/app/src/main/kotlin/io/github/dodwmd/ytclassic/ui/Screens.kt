package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.AssistChip
import androidx.compose.material3.TextButton
import androidx.compose.runtime.produceState
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import io.github.dodwmd.ytclassic.data.HistoryItem
import kotlinx.coroutines.CancellationException
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.FeedItem
import io.github.dodwmd.ytclassic.data.RelatedItem
import io.github.dodwmd.ytclassic.data.VideoSummary
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.formatSeconds
import io.github.dodwmd.ytclassic.data.formatViews
import io.github.dodwmd.ytclassic.data.joinParts
import io.github.dodwmd.ytclassic.data.timeAgo
import io.github.dodwmd.ytclassic.data.viewsText
import kotlinx.coroutines.launch

fun thumbUrl(id: String) = "https://i.ytimg.com/vi/$id/mqdefault.jpg"

@Composable
fun FeedRow(v: FeedItem, onVideo: (String) -> Unit, watched: Boolean = false) = VideoRow(
    thumb = thumbUrl(v.id), title = v.title, duration = null, watched = watched,
    details = listOf(v.channelTitle, joinParts(formatViews(v.views), timeAgo(v.publishedAt))),
    onClick = { onVideo(v.id) },
)

@Composable
fun RelatedRow(r: RelatedItem, onVideo: (String) -> Unit, thumbWidth: Int = 160, watched: Boolean = false) = VideoRow(
    thumb = r.thumb, title = r.title, duration = r.duration, thumbWidth = thumbWidth, watched = watched,
    details = listOf(r.channelTitle, joinParts(r.views?.let(::viewsText), r.age ?: timeAgo(r.publishedAt))),
    onClick = { onVideo(r.id) },
)

@Composable
fun SummaryRow(v: VideoSummary, onVideo: (String) -> Unit, watched: Boolean = false) = VideoRow(
    thumb = v.thumb, title = v.title, watched = watched, duration = v.durationSeconds?.takeIf { it > 0 }?.let(::formatSeconds),
    details = listOf(v.channelTitle, joinParts(timeAgo(v.publishedAt), formatViews(v.views))),
    onClick = { onVideo(v.id) },
)

/** The ids (of those asked about) that were watched to the end. A failure just means no badges. */
@Composable
fun rememberWatched(api: YtApi, ids: List<String>): Set<String> =
    produceState(emptySet<String>(), ids) {
        value = try {
            ids.chunked(100).flatMapTo(mutableSetOf()) { api.watched(it) }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            emptySet()
        }
    }.value

/** Row for a history entry: shows how far you got, as a bar and in words (for TalkBack). */
@Composable
fun HistoryRow(h: HistoryItem, onVideo: (String) -> Unit) = VideoRow(
    thumb = h.thumb.ifEmpty { thumbUrl(h.id) }, title = h.title, duration = h.durationSeconds.takeIf { it > 0 }?.let(::formatSeconds),
    details = listOf(
        h.channelTitle,
        if (h.completed) "Watched" else if (h.durationSeconds > 0) "${formatSeconds(h.position)} of ${formatSeconds(h.durationSeconds)} watched" else "${formatSeconds(h.position)} watched",
    ),
    progress = h.fraction, onClick = { onVideo(h.id) },
)

@Composable
fun HomeScreen(api: YtApi, onVideo: (String) -> Unit, onChannel: (String) -> Unit, onHistory: () -> Unit) {
    val loaded = rememberLoad { api.home() }
    LoadedContent(loaded) { home ->
        val watched = rememberWatched(api, home.feed.map { it.id })
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            if (home.resume.isNotEmpty()) {
                item { SectionTitle("Continue watching") }
                items(home.resume, key = { "c" + it.id }) { HistoryRow(it, onVideo) }
            }
            if (home.subs.isEmpty()) {
                item {
                    Text(
                        "No subscriptions yet. Search for a video, open its channel and tap Subscribe.",
                        modifier = Modifier.padding(16.dp),
                    )
                }
            } else {
                item { SectionTitle("Subscriptions") }
                item {
                    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(home.subs, key = { it.id }) { s -> AssistChip(onClick = { onChannel(s.id) }, label = { Text(s.title) }) }
                    }
                }
                item { SectionTitle("New from your subscriptions") }
                items(home.feed.distinctBy { it.id }, key = { it.id }) { FeedRow(it, onVideo, it.id in watched) }
            }
            item { TextButton(onClick = onHistory, modifier = Modifier.padding(horizontal = 4.dp)) { Text("Watch history") } }
        }
    }
}

@Composable
fun HistoryScreen(api: YtApi, onVideo: (String) -> Unit) {
    val first = rememberLoad { api.history() }
    LoadedContent(first) { page ->
        var items by remember(page) { mutableStateOf(page.items) }
        var next by remember(page) { mutableStateOf(page.next) }
        var failure by remember(page) { mutableStateOf<String?>(null) }
        var confirmClear by remember(page) { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        fun attempt(block: suspend () -> Unit) {
            scope.launch {
                try {
                    block()
                    failure = null
                } catch (e: ApiException) {
                    failure = e.message
                }
            }
        }
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Watch history", style = MaterialTheme.typography.titleLarge)
                    Text("Kept only on your own server, nowhere else.", color = Muted)
                    OutlinedButton(enabled = items.isNotEmpty(), onClick = { confirmClear = true }) { Text("Clear all history") }
                    failure?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (items.isEmpty()) Text("Nothing watched yet.")
                }
            }
            items(items, key = { it.id }) { h ->
                Column {
                    HistoryRow(h, onVideo)
                    TextButton(
                        onClick = { attempt { api.removeFromHistory(h.id); items = items.filter { it.id != h.id } } },
                        modifier = Modifier.padding(horizontal = 4.dp).semantics { contentDescription = "Remove ${h.title} from history" },
                    ) { Text("Remove") }
                }
            }
            if (next != null) {
                item {
                    OutlinedButton(modifier = Modifier.padding(12.dp), onClick = {
                        attempt {
                            val more = api.history(next)
                            items = items + more.items.filter { n -> items.none { it.id == n.id } }
                            next = more.next
                        }
                    }) { Text("Load more") }
                }
            }
        }
        if (confirmClear) {
            AlertDialog(
                onDismissRequest = { confirmClear = false },
                title = { Text("Clear all history?") },
                text = { Text("This removes every watched video and resume position from your server. It cannot be undone.") },
                confirmButton = { TextButton(onClick = { confirmClear = false; attempt { api.clearHistory(); items = emptyList(); next = null } }) { Text("Clear") } },
                dismissButton = { TextButton(onClick = { confirmClear = false }) { Text("Cancel") } },
            )
        }
    }
}

@Composable
fun SearchScreen(api: YtApi, query: String, onVideo: (String) -> Unit) {
    val first = rememberLoad(query) { api.search(query) }
    LoadedContent(first) { page ->
        // Duplicate ids would crash the list (they are its keys), so drop any the server sends.
        var items by remember(page) { mutableStateOf(page.items.distinctBy { it.id }) }
        var token by remember(page) { mutableStateOf(page.nextPageToken) }
        var failure by remember(page) { mutableStateOf<String?>(null) }
        val scope = rememberCoroutineScope()
        val watched = rememberWatched(api, items.map { it.id })
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item { SectionTitle("Results for \"$query\"") }
            if (items.isEmpty()) item { Text("No results.", modifier = Modifier.padding(12.dp)) }
            items(items, key = { it.id }) { SummaryRow(it, onVideo, it.id in watched) }
            item {
                Column(Modifier.fillMaxWidth().padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    failure?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (token != null) {
                        OutlinedButton(onClick = {
                            scope.launch {
                                try {
                                    val next = api.search(query, token)
                                    items = items + next.items.filter { n -> items.none { it.id == n.id } }
                                    token = next.nextPageToken
                                    failure = null
                                } catch (e: ApiException) {
                                    failure = e.message
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
fun ChannelScreen(api: YtApi, id: String, onVideo: (String) -> Unit) {
    val loaded = rememberLoad(id) { api.channel(id) }
    LoadedContent(loaded) { c ->
        var subscribed by remember(c) { mutableStateOf(c.subscribed) }
        var busy by remember(c) { mutableStateOf(false) }
        var failure by remember(c) { mutableStateOf<String?>(null) }
        var items by remember(c) { mutableStateOf(c.page.items.distinctBy { it.id }) }
        var token by remember(c) { mutableStateOf(c.page.nextPageToken) }
        var showAbout by remember(c) { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
        val watched = rememberWatched(api, items.map { it.id })
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
                failure?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp)) }
                if (c.channel.description.isNotBlank()) {
                    Text(
                        if (showAbout) "▼ About" else "▶ About", color = LinkBlue,
                        modifier = Modifier.clickable { showAbout = !showAbout }.padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                    if (showAbout) Text(c.channel.description, modifier = Modifier.padding(horizontal = 12.dp), color = Muted)
                }
            }
            item { SectionTitle("Uploads") }
            items(items, key = { it.id }) { SummaryRow(it, onVideo, it.id in watched) }
            if (token != null) {
                item {
                    OutlinedButton(modifier = Modifier.padding(12.dp), onClick = {
                        scope.launch {
                            try {
                                val next = api.channel(c.channel.id, token)
                                items = items + next.page.items.filter { n -> items.none { it.id == n.id } }
                                token = next.page.nextPageToken
                            } catch (e: ApiException) {
                                failure = e.message
                            }
                        }
                    }) { Text("Load more") }
                }
            }
        }
    }
}
