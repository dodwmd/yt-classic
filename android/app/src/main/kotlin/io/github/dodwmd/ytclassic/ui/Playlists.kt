package io.github.dodwmd.ytclassic.ui

import android.widget.Toast
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import io.github.dodwmd.ytclassic.data.ApiException
import io.github.dodwmd.ytclassic.data.Playlist
import io.github.dodwmd.ytclassic.data.PlaylistItem
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.formatSeconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** The built-in playlist every "Watch later" control talks to (fixed id on the server). */
const val WATCH_LATER_ID = 1L

/**
 * Which videos are in Watch later, plus the toggle. One video at a time can be in flight (a second tap on the same
 * video is ignored); a failure is kept per video so the row can show it next to the control.
 */
class LaterState(private val api: YtApi, private val scope: CoroutineScope) {
    var members by mutableStateOf(emptySet<String>())
    var busy by mutableStateOf(emptySet<String>())
    var errors by mutableStateOf(emptyMap<String, String>())

    fun toggle(id: String) {
        if (id in busy) return
        busy = busy + id
        scope.launch {
            try {
                if (id in members) {
                    api.removeFromPlaylist(WATCH_LATER_ID, id)
                    members = members - id
                } else {
                    api.addToPlaylist(WATCH_LATER_ID, id)
                    members = members + id
                }
                errors = errors - id
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                errors = errors + (id to (e.message ?: "Request failed."))
            } finally {
                busy = busy - id
            }
        }
    }
}

/** Loads the Watch later membership of [ids] (each asked once; a failure only means no check marks yet). */
@Composable
fun rememberLater(api: YtApi, ids: List<String>): LaterState {
    val scope = rememberCoroutineScope()
    val state = remember(api) { LaterState(api, scope) }
    val asked = remember(api) { mutableSetOf<String>() }
    LaunchedEffect(ids) {
        for (chunk in ids.filter { it !in asked }.chunked(100)) {
            try {
                state.members = state.members + api.inWatchLater(chunk)
                asked += chunk
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // no marks for this chunk; asked again next time
            }
        }
    }
    return state
}

/** The "+" / check toggle at the end of a list row: 48dp, named for TalkBack. */
@Composable
fun LaterButton(later: LaterState, id: String, title: String) {
    val on = id in later.members
    IconButton(
        onClick = { later.toggle(id) }, enabled = id !in later.busy,
        modifier = Modifier.size(48.dp).semantics { contentDescription = if (on) "Remove $title from Watch later" else "Add $title to Watch later" },
    ) { Text(if (on) "✓" else "+", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = if (on) LogoRed else LinkBlue) }
}

/** The labelled button on the watch screen, with the failure underneath. */
@Composable
fun WatchLaterButton(later: LaterState, id: String, title: String) {
    val on = id in later.members
    Column {
        OutlinedButton(
            onClick = { later.toggle(id) }, enabled = id !in later.busy,
            modifier = Modifier.semantics { contentDescription = if (on) "Remove $title from Watch later" else "Add $title to Watch later" },
        ) { Text(if (on) "✓ In Watch later" else "Watch later") }
        later.errors[id]?.let { Text(it, color = MaterialTheme.colorScheme.error) }
    }
}

/** One request at a time (no double taps); a failure is kept and also toasted, since the list may be scrolled away from it. */
class Guard(private val scope: CoroutineScope, private val toast: (String) -> Unit) {
    var busy by mutableStateOf(false)
    var failure by mutableStateOf<String?>(null)

    fun run(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch {
            try {
                block()
                failure = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                failure = e.message
                toast(e.message ?: "Request failed.")
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun rememberGuard(): Guard {
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    return remember { Guard(scope) { Toast.makeText(context, it, Toast.LENGTH_LONG).show() } }
}

private fun countText(n: Int) = if (n == 1) "1 video" else "$n videos"

@Composable
fun PlaylistsScreen(api: YtApi, onOpen: (Long) -> Unit) {
    val first = rememberLoad { api.playlists() }
    LoadedContent(first) { loaded ->
        var lists by remember(loaded) { mutableStateOf(loaded) }
        var newName by remember(loaded) { mutableStateOf("") }
        var renaming by remember(loaded) { mutableStateOf<Playlist?>(null) }
        var deleting by remember(loaded) { mutableStateOf<Playlist?>(null) }
        val guard = rememberGuard()
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Playlists", style = MaterialTheme.typography.titleLarge)
                    Text("Only what you add yourself. Kept on your own server.", color = Muted)
                    OutlinedTextField(
                        value = newName, onValueChange = { newName = it.take(80) }, singleLine = true,
                        label = { Text("New playlist name") }, modifier = Modifier.fillMaxWidth(),
                    )
                    OutlinedButton(enabled = newName.isNotBlank() && !guard.busy, onClick = {
                        guard.run { lists = lists + api.createPlaylist(newName); newName = "" }
                    }) { Text("Create playlist") }
                    guard.failure?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            }
            items(lists, key = { it.id }) { p ->
                Row(Modifier.fillMaxWidth().clickable { onOpen(p.id) }.padding(horizontal = 12.dp).heightIn(min = 56.dp), verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text(p.name, color = LinkBlue, fontWeight = FontWeight.Medium)
                        Text(countText(p.count), color = Muted, fontSize = 12.sp)
                    }
                    if (!p.builtin) {
                        TextButton(enabled = !guard.busy, onClick = { renaming = p }, modifier = Modifier.semantics { contentDescription = "Rename ${p.name}" }) { Text("Rename") }
                        TextButton(enabled = !guard.busy, onClick = { deleting = p }, modifier = Modifier.semantics { contentDescription = "Delete ${p.name}" }) { Text("Delete") }
                    }
                }
            }
        }
        renaming?.let { p ->
            var name by remember(p) { mutableStateOf(p.name) }
            AlertDialog(
                onDismissRequest = { renaming = null },
                title = { Text("Rename playlist") },
                text = { OutlinedTextField(value = name, onValueChange = { name = it.take(80) }, singleLine = true, label = { Text("Name") }) },
                confirmButton = {
                    TextButton(enabled = name.isNotBlank(), onClick = {
                        renaming = null
                        guard.run { val r = api.renamePlaylist(p.id, name); lists = lists.map { if (it.id == p.id) r else it } }
                    }) { Text("Rename") }
                },
                dismissButton = { TextButton(onClick = { renaming = null }) { Text("Cancel") } },
            )
        }
        deleting?.let { p ->
            AlertDialog(
                onDismissRequest = { deleting = null },
                title = { Text("Delete \"${p.name}\"?") },
                text = { Text("The playlist and its list of videos are removed from your server. The videos themselves are not affected.") },
                confirmButton = {
                    TextButton(onClick = {
                        deleting = null
                        guard.run { api.deletePlaylist(p.id); lists = lists.filter { it.id != p.id } }
                    }) { Text("Delete") }
                },
                dismissButton = { TextButton(onClick = { deleting = null }) { Text("Cancel") } },
            )
        }
    }
}

@Composable
fun PlaylistRow(h: PlaylistItem, onVideo: (String) -> Unit) = VideoRow(
    thumb = h.thumb.ifEmpty { thumbUrl(h.id) }, title = h.title, duration = h.durationSeconds.takeIf { it > 0 }?.let(::formatSeconds),
    details = listOf(h.channelTitle), onClick = { onVideo(h.id) },
)

@Composable
fun PlaylistScreen(api: YtApi, id: Long, onVideo: (String) -> Unit) {
    val first = rememberLoad(id) { api.playlist(id) }
    LoadedContent(first) { page ->
        var items by remember(page) { mutableStateOf(page.items) }
        var next by remember(page) { mutableStateOf(page.next) }
        val guard = rememberGuard()
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(page.playlist.name, style = MaterialTheme.typography.titleLarge)
                    // Plain order: this opens the first video; nothing plays on after it.
                    items.firstOrNull()?.let { f -> OutlinedButton(onClick = { onVideo(f.id) }, modifier = Modifier.semantics { contentDescription = "Play ${page.playlist.name}: ${f.title}" }) { Text("Play") } }
                    guard.failure?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                    if (items.isEmpty()) Text("Nothing here yet. Use the + on any video to add it.")
                }
            }
            items(items, key = { it.id }) { h ->
                Column {
                    PlaylistRow(h, onVideo)
                    Row(Modifier.padding(horizontal = 4.dp)) {
                        TextButton(
                            enabled = !guard.busy && h.id != items.first().id,
                            onClick = { guard.run { api.moveToTop(id, h.id); items = listOf(h) + items.filter { it.id != h.id } } },
                            modifier = Modifier.semantics { contentDescription = "Move ${h.title} to the top" },
                        ) { Text("Move to top") }
                        TextButton(
                            enabled = !guard.busy,
                            onClick = { guard.run { api.removeFromPlaylist(id, h.id); items = items.filter { it.id != h.id } } },
                            modifier = Modifier.semantics { contentDescription = "Remove ${h.title} from ${page.playlist.name}" },
                        ) { Text("Remove") }
                    }
                }
            }
            if (next != null) {
                item {
                    OutlinedButton(modifier = Modifier.padding(12.dp), enabled = !guard.busy, onClick = {
                        guard.run {
                            val more = api.playlist(id, next)
                            items = items + more.items.filter { n -> items.none { it.id == n.id } }
                            next = more.next
                        }
                    }) { Text("Load more") }
                }
            }
        }
    }
}
