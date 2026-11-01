package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.toggleableState
import androidx.compose.ui.state.ToggleableState
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import io.github.dodwmd.ytclassic.data.AuthException
import io.github.dodwmd.ytclassic.data.MembershipTracker
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
    private val tracker = MembershipTracker { api.inWatchLater(it) }
    var members by mutableStateOf(emptySet<String>())
        private set
    var busy by mutableStateOf(emptySet<String>())
        private set
    var errors by mutableStateOf(emptyMap<String, String>())
        private set

    /** Ids whose last failure was a missing or wrong access token: the row then offers Open Settings. */
    var needsToken by mutableStateOf(emptySet<String>())
        private set

    /** Whether the server has said if [id] is in Watch later; until then the control shows no definite state. */
    fun known(id: String): Boolean {
        version // read, so a reply that changes nothing else still recomposes the controls
        return id in members || tracker.known(id)
    }

    private var version by mutableIntStateOf(0)

    suspend fun load(ids: List<String>) = tracker.load(ids) {
        members = tracker.members
        version++
    }

    fun toggle(id: String) {
        if (id in busy) return
        busy = busy + id
        scope.launch {
            try {
                if (id in members) {
                    api.removeFromPlaylist(WATCH_LATER_ID, id)
                    tracker.set(id, false)
                } else {
                    api.addToPlaylist(WATCH_LATER_ID, id)
                    tracker.set(id, true)
                }
                members = tracker.members
                errors = errors - id
                needsToken = needsToken - id
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                errors = errors + (id to (e.message ?: "Request failed."))
                needsToken = if (e is AuthException) needsToken + id else needsToken - id
            } finally {
                busy = busy - id
            }
        }
    }
}

/** Loads the Watch later membership of [ids] (each asked once; a failure only means no marks yet, retried later). */
@Composable
fun rememberLater(api: YtApi, ids: List<String>): LaterState {
    val scope = rememberCoroutineScope()
    val state = remember(api) { LaterState(api, scope) }
    LaunchedEffect(ids) {
        try {
            state.load(ids)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // unknown for now: the controls show no state until a later attempt succeeds
        }
    }
    return state
}

private fun Modifier.laterToggle(later: LaterState, id: String, title: String, on: Boolean): Modifier = this.semantics {
    contentDescription = "Watch later: $title"
    stateDescription = if (on) "In Watch later" else "Not in Watch later"
    role = Role.Checkbox
    toggleableState = ToggleableState(on)
}

/** The failure for [id], right under the control, with a way out when the cause is the access token. */
@Composable
fun LaterNote(later: LaterState, id: String) {
    val message = later.errors[id] ?: return
    Text(message, color = MaterialTheme.colorScheme.error, fontSize = 12.sp, maxLines = 3, overflow = TextOverflow.Ellipsis)
    if (id in later.needsToken) {
        val openSettings = LocalOpenSettings.current
        TextButton(onClick = openSettings) { Text("Open Settings") }
    }
}

/** The "+" / check toggle at the end of a list row: 48dp, a real checkbox for TalkBack. Nothing until the state is known. */
@Composable
fun LaterButton(later: LaterState, id: String, title: String) {
    val on = id in later.members
    if (!later.known(id)) {
        Box(Modifier.size(48.dp))
        return
    }
    Box(
        Modifier.size(48.dp).toggleable(value = on, enabled = id !in later.busy, role = Role.Checkbox, onValueChange = { later.toggle(id) })
            .laterToggle(later, id, title, on),
        contentAlignment = Alignment.Center,
    ) { Text(if (on) "✓" else "+", fontSize = 22.sp, fontWeight = FontWeight.Bold, color = if (on) MaterialTheme.colorScheme.primary else LinkBlue) }
}

/** The labelled button on the watch screen, with the failure underneath. */
@Composable
fun WatchLaterButton(later: LaterState, id: String, title: String) {
    val on = id in later.members
    Column {
        if (later.known(id)) {
            OutlinedButton(onClick = { later.toggle(id) }, enabled = id !in later.busy, modifier = Modifier.laterToggle(later, id, title, on)) {
                Text(if (on) "✓ In Watch later" else "Watch later")
            }
        }
        LaterNote(later, id)
    }
}

/**
 * One request at a time (no double taps). Each action has its own [key], so a failure is shown next to the control
 * that caused it and is cleared when that same action is tried again or succeeds.
 */
class Guard(private val scope: CoroutineScope) {
    var busy by mutableStateOf(false)
        private set
    var failures by mutableStateOf(emptyMap<String, String>())
        private set

    fun clear(key: String) {
        failures = failures - key
    }

    fun run(key: String, onSuccess: () -> Unit = {}, block: suspend () -> Unit) {
        if (busy) return
        busy = true
        failures = failures - key
        scope.launch {
            try {
                block()
                onSuccess()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiException) {
                failures = failures + (key to (e.message ?: "Request failed."))
            } finally {
                busy = false
            }
        }
    }
}

@Composable
fun rememberGuard(): Guard {
    val scope = rememberCoroutineScope()
    return remember { Guard(scope) }
}

private fun countText(n: Int) = if (n == 1) "1 video" else "$n videos"

private fun error(guard: Guard, key: String): @Composable () -> Unit = {
    guard.failures[key]?.let { Text(it, color = MaterialTheme.colorScheme.error) }
}

@Composable
fun PlaylistsScreen(api: YtApi, onOpen: (Long) -> Unit) {
    val first = rememberLoad { api.playlists() }
    LoadedContent(first) { loaded ->
        var lists by remember(loaded) { mutableStateOf(loaded) }
        var newName by remember(loaded) { mutableStateOf("") }
        var renaming by remember(loaded) { mutableStateOf<Playlist?>(null) }
        var deleting by remember(loaded) { mutableStateOf<Playlist?>(null) }
        val guard = rememberGuard()
        val create = {
            val name = newName.trim()
            if (name.isNotEmpty()) guard.run("create", onSuccess = { newName = "" }) { lists = lists + api.createPlaylist(name) }
        }
        LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("Playlists", style = MaterialTheme.typography.titleLarge)
                    Text("Only what you add yourself. Kept on your own server.", color = Muted)
                    OutlinedTextField(
                        value = newName, onValueChange = { newName = it.take(80) }, singleLine = true,
                        label = { Text("New playlist name") }, modifier = Modifier.fillMaxWidth(),
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { create() }),
                    )
                    OutlinedButton(enabled = newName.isNotBlank() && !guard.busy, onClick = { create() }) { Text("Create playlist") }
                    error(guard, "create")()
                }
            }
            items(lists, key = { it.id }) { p ->
                Column {
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
                    Box(Modifier.padding(horizontal = 12.dp)) { error(guard, "delete:${p.id}")() }
                }
            }
        }
        renaming?.let { p ->
            var name by remember(p) { mutableStateOf(p.name) }
            val focus = remember { FocusRequester() }
            LaunchedEffect(p) { focus.requestFocus() }
            val rename = {
                val n = name.trim()
                if (n.isNotEmpty()) guard.run("rename", onSuccess = { renaming = null }) {
                    val r = api.renamePlaylist(p.id, n)
                    lists = lists.map { if (it.id == p.id) r else it }
                }
            }
            // Stays open until the server accepts the name, so an error (duplicate, too long) is shown right here.
            AlertDialog(
                onDismissRequest = { guard.clear("rename"); renaming = null },
                title = { Text("Rename playlist") },
                text = {
                    Column {
                        OutlinedTextField(
                            value = name, onValueChange = { name = it.take(80) }, singleLine = true, label = { Text("Name") },
                            modifier = Modifier.focusRequester(focus),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { rename() }),
                        )
                        error(guard, "rename")()
                    }
                },
                confirmButton = { TextButton(enabled = name.isNotBlank() && !guard.busy, onClick = { rename() }) { Text("Rename") } },
                dismissButton = { TextButton(onClick = { guard.clear("rename"); renaming = null }) { Text("Cancel") } },
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
                        guard.run("delete:${p.id}") { api.deletePlaylist(p.id); lists = lists.filter { it.id != p.id } }
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
                    // More pages may still hold videos, so "empty" is only true when there is nothing left to load.
                    if (items.isEmpty() && next == null) Text("Nothing here yet. Use the + on any video to add it.")
                }
            }
            items(items, key = { it.id }) { h ->
                Column {
                    PlaylistRow(h, onVideo)
                    Row(Modifier.padding(horizontal = 4.dp)) {
                        TextButton(
                            enabled = !guard.busy && h.id != items.first().id,
                            onClick = { guard.run("item:${h.id}") { api.moveToTop(id, h.id); items = listOf(h) + items.filter { it.id != h.id } } },
                            modifier = Modifier.semantics { contentDescription = "Move ${h.title} to the top" },
                        ) { Text("Move to top") }
                        TextButton(
                            enabled = !guard.busy,
                            onClick = { guard.run("item:${h.id}") { api.removeFromPlaylist(id, h.id); items = items.filter { it.id != h.id } } },
                            modifier = Modifier.semantics { contentDescription = "Remove ${h.title} from ${page.playlist.name}" },
                        ) { Text("Remove") }
                    }
                    Box(Modifier.padding(horizontal = 12.dp)) { error(guard, "item:${h.id}")() }
                }
            }
            if (next != null) {
                item {
                    Column(Modifier.padding(12.dp)) {
                        OutlinedButton(enabled = !guard.busy, onClick = {
                            guard.run("more") {
                                val more = api.playlist(id, next)
                                items = items + more.items.filter { n -> items.none { it.id == n.id } }
                                next = more.next
                            }
                        }) { Text("Load more") }
                        error(guard, "more")()
                    }
                }
            }
        }
    }
}
