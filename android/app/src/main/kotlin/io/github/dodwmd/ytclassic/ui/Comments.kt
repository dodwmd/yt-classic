package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import coil3.compose.AsyncImage
import io.github.dodwmd.ytclassic.data.Chunk
import io.github.dodwmd.ytclassic.data.Comment
import io.github.dodwmd.ytclassic.data.YtApi
import kotlinx.coroutines.CoroutineScope
import io.github.dodwmd.ytclassic.data.commentAge
import io.github.dodwmd.ytclassic.data.commentFooter
import io.github.dodwmd.ytclassic.data.commentsToggleLabel
import io.github.dodwmd.ytclassic.data.likesLabel
import io.github.dodwmd.ytclassic.data.repliesDescription
import io.github.dodwmd.ytclassic.data.repliesLabel

/** Loads the first page of [this] once, unless it already has one, is running, or failed (the footer's Retry handles that). */
fun <T> PagedList<T>.loadFirst() {
    if (!state.started && !state.loading && state.error == null) load()
}

/**
 * What one Watch screen's comments have loaded, kept by the back stack entry like [ChannelModel]: a rotation, or a detour to
 * a related video and back, finds the lists, the pages and the expanded threads as they were. Nothing is requested until the
 * section is opened. Top and Newest are separate lists, so switching does not throw away what was loaded.
 */
class CommentsModel(private val api: YtApi, private val videoId: String, scope: CoroutineScope? = null) : ViewModel() {
    private val scope = scope ?: viewModelScope // (tests pass their own: viewModelScope needs the Android main thread)
    private fun threads(order: String) = PagedList(this.scope, { c: Comment -> c.id }, label = "comments") { t -> api.comments(videoId, order, t).let { Chunk(it.items, it.nextPageToken) } }
    val top = threads("top")
    val newest = threads("new")
    fun list(order: String) = if (order == "new") newest else top
    val expanded = mutableStateMapOf<String, Boolean>()
    private val replies = HashMap<String, PagedList<Comment>>()
    fun replies(commentId: String) = replies.getOrPut(commentId) {
        PagedList(scope, { c: Comment -> c.id }, label = "comment replies") { t -> api.commentReplies(commentId, t).let { Chunk(it.items, it.nextPageToken) } }
    }
}

/**
 * The collapsed "Show comments" row and, once opened, the sort chips and the comments (all plain text) with their footer.
 * [open] and [order] ("top" or "new") belong to the caller so it can save them across rotation and process death.
 */
fun LazyListScope.commentsSection(model: CommentsModel, count: Long?, open: Boolean, onOpen: (Boolean) -> Unit, order: String, onOrder: (String) -> Unit) {
    val list = model.list(order)
    item(key = "comments:head", contentType = "comments-head") {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 4.dp)) {
            OutlinedButton(
                onClick = { onOpen(!open) },
                modifier = Modifier.fillMaxWidth().heightIn(min = 48.dp).semantics { heading(); stateDescription = if (open) "Expanded" else "Collapsed" },
            ) { Text(commentsToggleLabel(count, open)) }
            if (open) Row(Modifier.padding(top = 4.dp).selectableGroup().semantics { contentDescription = "Sort comments" }, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = order == "top", onClick = { onOrder("top") }, label = { Text("Top") })
                FilterChip(selected = order == "new", onClick = { onOrder("new") }, label = { Text("Newest") })
            }
        }
    }
    if (!open) return
    for (c in list.state.items) {
        item(key = "cm:$order:${c.id}", contentType = "comment") {
            CommentRow(c, expanded = model.expanded[c.id] == true, onReplies = {
                val now = model.expanded[c.id] != true
                model.expanded[c.id] = now
                if (now) model.replies(c.id).loadFirst()
            })
        }
        if (model.expanded[c.id] == true) {
            val replies = model.replies(c.id)
            val rs = replies.state
            items(rs.items.size, key = { "cr:$order:${c.id}:${rs.items[it].id}" }, contentType = { "reply" }) { CommentRow(rs.items[it], expanded = false, onReplies = {}, indent = true) }
            footerItem(replies, "crf:$order:${c.id}", "No replies.", "Show more replies", indent = true)
        }
    }
    footerItem(list, "cmf:$order", "No comments yet.", "Load more")
}

private const val COLLAPSED_LINES = 6

@Composable
private fun CommentRow(c: Comment, expanded: Boolean, onReplies: () -> Unit, indent: Boolean = false) {
    var full by rememberSaveable(c.id) { mutableStateOf(false) }
    var clipped by remember(c.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(start = if (indent) 44.dp else 12.dp, end = 12.dp, top = 6.dp, bottom = 2.dp)) {
        Row(Modifier.semantics(mergeDescendants = true) {}, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Avatar(c.authorThumb)
            Column(Modifier.weight(1f)) {
                Text(c.author.ifBlank { "Unknown" }, fontWeight = FontWeight.Bold, fontSize = 13.sp, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(commentAge(c), color = Muted, fontSize = 12.sp)
                Text(
                    c.text, maxLines = if (full) Int.MAX_VALUE else COLLAPSED_LINES, overflow = TextOverflow.Ellipsis,
                    onTextLayout = { if (!full) clipped = it.hasVisualOverflow },
                )
                val likes = likesLabel(c.likeCount)
                if (likes.isNotEmpty()) Text(likes, color = Muted, fontSize = 12.sp)
            }
        }
        if (clipped || full) TextButton(onClick = { full = !full }, modifier = Modifier.heightIn(min = 48.dp).padding(start = 42.dp)) {
            Text(if (full) "Show less" else "Read more", color = LinkBlue)
        }
        if (c.replyCount > 0) TextButton(
            onClick = onReplies,
            modifier = Modifier.heightIn(min = 48.dp).padding(start = 42.dp).semantics {
                stateDescription = if (expanded) "Expanded" else "Collapsed"
                contentDescription = repliesDescription(c.replyCount, expanded, c.author)
            },
        ) { Text(repliesLabel(c.replyCount, expanded), color = LinkBlue) }
    }
}

@Composable
private fun Avatar(url: String?) {
    val shape = Modifier.size(32.dp).clip(CircleShape).background(Muted.copy(alpha = 0.3f))
    if (url != null && url.startsWith("https://")) AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = shape)
    else Box(shape)
}

/** Spinner, error with Retry (never for turned-off comments, which just say so), "Load more", or the empty note: [commentFooter] decides. */
private fun <T> LazyListScope.footerItem(list: PagedList<T>, key: String, empty: String, more: String, indent: Boolean = false) {
    item(key = key, contentType = "comments-footer") {
        val f = commentFooter(list.state)
        Column(
            Modifier.fillMaxWidth().padding(start = if (indent) 44.dp else 12.dp, end = 12.dp, top = 8.dp, bottom = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
            verticalArrangement = Arrangement.spacedBy(8.dp),
        ) {
            if (f.spinner) CircularProgressIndicator(Modifier.semantics { contentDescription = "Loading comments" })
            f.message?.let { Text(it, color = if (f.muted) Muted else MaterialTheme.colorScheme.error) }
            if (f.openSettings) {
                val openSettings = LocalOpenSettings.current
                Button(onClick = openSettings) { Text("Open Settings") }
            }
            f.hint?.let { h -> Text(h, color = Muted) }
            if (f.retry) OutlinedButton(onClick = { list.load() }, enabled = !list.state.loading) { Text("Retry") }
            if (f.loadMore) OutlinedButton(onClick = { list.load() }) { Text(more) }
            if (f.empty) Text(empty, color = Muted)
        }
    }
}
