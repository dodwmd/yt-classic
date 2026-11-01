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
import androidx.compose.material3.AssistChip
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
fun FeedRow(v: FeedItem, onVideo: (String) -> Unit) = VideoRow(
    thumb = thumbUrl(v.id), title = v.title, duration = null,
    details = listOf(v.channelTitle, joinParts(formatViews(v.views), timeAgo(v.publishedAt))),
    onClick = { onVideo(v.id) },
)

@Composable
fun RelatedRow(r: RelatedItem, onVideo: (String) -> Unit, thumbWidth: Int = 160) = VideoRow(
    thumb = r.thumb, title = r.title, duration = r.duration, thumbWidth = thumbWidth,
    details = listOf(r.channelTitle, joinParts(r.views?.let(::viewsText), r.age ?: timeAgo(r.publishedAt))),
    onClick = { onVideo(r.id) },
)

@Composable
fun SummaryRow(v: VideoSummary, onVideo: (String) -> Unit) = VideoRow(
    thumb = v.thumb, title = v.title, duration = v.durationSeconds?.takeIf { it > 0 }?.let(::formatSeconds),
    details = listOf(v.channelTitle, joinParts(timeAgo(v.publishedAt), formatViews(v.views))),
    onClick = { onVideo(v.id) },
)

@Composable
fun HomeScreen(api: YtApi, onVideo: (String) -> Unit, onChannel: (String) -> Unit) {
    val loaded = rememberLoad { api.home() }
    LoadedContent(loaded) { home ->
        if (home.subs.isEmpty()) {
            Text(
                "No subscriptions yet. Search for a video, open its channel and tap Subscribe.",
                modifier = Modifier.padding(16.dp),
            )
        } else {
            LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
                item { SectionTitle("Subscriptions") }
                item {
                    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        items(home.subs, key = { it.id }) { s -> AssistChip(onClick = { onChannel(s.id) }, label = { Text(s.title) }) }
                    }
                }
                item { SectionTitle("New from your subscriptions") }
                items(home.feed, key = { it.id }) { FeedRow(it, onVideo) }
            }
        }
    }
}

@Composable
fun SearchScreen(api: YtApi, query: String, onVideo: (String) -> Unit) {
    val first = rememberLoad(query) { api.search(query) }
    LoadedContent(first) { page ->
        var items by remember(page) { mutableStateOf(page.items) }
        var token by remember(page) { mutableStateOf(page.nextPageToken) }
        var failure by remember(page) { mutableStateOf<String?>(null) }
        val scope = rememberCoroutineScope()
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item { SectionTitle("Results for \"$query\"") }
            if (items.isEmpty()) item { Text("No results.", modifier = Modifier.padding(12.dp)) }
            items(items, key = { it.id }) { SummaryRow(it, onVideo) }
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
        var items by remember(c) { mutableStateOf(c.page.items) }
        var token by remember(c) { mutableStateOf(c.page.nextPageToken) }
        var showAbout by remember(c) { mutableStateOf(false) }
        val scope = rememberCoroutineScope()
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
            items(items, key = { it.id }) { SummaryRow(it, onVideo) }
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
