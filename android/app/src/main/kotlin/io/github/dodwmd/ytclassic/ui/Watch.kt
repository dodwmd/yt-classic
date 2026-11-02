package io.github.dodwmd.ytclassic.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import io.github.dodwmd.ytclassic.data.formatLikes
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.movableContentOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import io.github.dodwmd.ytclassic.data.shortMessage
import io.github.dodwmd.ytclassic.data.showPlayer
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.initializer
import androidx.lifecycle.viewmodel.viewModelFactory
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.formatViews
import io.github.dodwmd.ytclassic.data.joinParts
import io.github.dodwmd.ytclassic.data.timeAgo
import io.github.dodwmd.ytclassic.player.LocalPip
import io.github.dodwmd.ytclassic.player.StreamPlayer
import io.github.dodwmd.ytclassic.player.qualityPlan
import io.github.dodwmd.ytclassic.player.screenShortSide
import androidx.compose.ui.platform.LocalContext
import io.github.dodwmd.ytclassic.App
import kotlinx.coroutines.flow.first
import io.github.dodwmd.ytclassic.player.withOffers
import io.github.dodwmd.ytclassic.player.AUTO_QUALITY
import io.github.dodwmd.ytclassic.data.QualitiesResponse
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import io.github.dodwmd.ytclassic.player.resumeStart

@Composable
fun WatchScreen(
    api: YtApi, id: String, startSeconds: Long, fullscreen: Boolean, onFullscreen: (Boolean) -> Unit,
    onVideo: (String) -> Unit, onChannel: (String) -> Unit,
) {
    // Leaving this screen (back, or opening another video) must not leave the app stuck in fullscreen.
    DisposableEffect(Unit) { onDispose { onFullscreen(false) } }
    // Survives leaving the screen and coming back (or the process being killed), so a detour doesn't lose your place.
    // A LongArray rather than state: it's written every few seconds and nothing should recompose for it.
    val resume = rememberSaveable(id) { longArrayOf(startSeconds) }
    val app = LocalContext.current.applicationContext as App
    // The stored quality (or Auto) goes with the request so the server can answer for this screen and these decoders; the
    // chips and the starting tier come from the answer plus what this device can decode.
    val loaded = rememberLoad(id) {
        val pref = app.settings.qualityPref.first()
        val decoders = withContext(Dispatchers.Default) { app.host.decoders } // normally already warm (App starts it)
        val screen = minOf(screenShortSide(app), decoders.best)
        val response = api.video(id, pref, screen, decoders.codecsParam)
        response to qualityPlan(response, pref, decoders, screen)
    }
    LoadedContent(loaded) { (r, plan) ->
        val v = r.video
        var expanded by remember(v.id) { mutableStateOf(false) }
        // Comments cost nothing until opened; the open state and the sort order survive rotation, the loaded pages live in the model.
        val comments = viewModel<CommentsModel>(key = "comments:${v.id}", factory = viewModelFactory { initializer { CommentsModel(api, v.id) } })
        var commentsOpen by rememberSaveable(v.id) { mutableStateOf(false) }
        var commentsOrder by rememberSaveable(v.id) { mutableStateOf("top") }
        LaunchedEffect(commentsOpen, commentsOrder) { if (commentsOpen) comments.list(commentsOrder).loadFirst() }
        val later = rememberLater(api, (listOf(v.id) + r.related.items.map { it.id }).distinct())
        // In picture-in-picture only the player shows, so never the two-pane layout.
        val inPip = LocalPip.current.inPip
        // Wide windows (tablets, landscape): player left, details and related right. Portrait phones keep one column.
        val size = LocalWindowInfo.current.containerSize
        val density = LocalDensity.current
        val twoPane = !inPip && !fullscreen &&
            useTwoPane(with(density) { size.width.toDp().value.toInt() }, with(density) { size.height.toDp().value.toInt() })
        // The server's "can't play" hint never hides the player for good: "Try anyway" mounts it (kept across recomposition).
        var override by rememberSaveable(v.id) { mutableStateOf(false) }
        // The player and the details list are each composed ONCE and moved between layouts (rotation, fullscreen,
        // PiP): recreating StreamPlayer would stop and restart playback, and the list would lose its scroll.
        // The movable lambdas outlive recompositions, so they read the latest values through these.
        val latest by rememberUpdatedState(r)
        // The page data carries the usual tiers; the ones this video really has arrive separately and only change the chips.
        var offers by remember(v.id) { mutableStateOf<QualitiesResponse?>(null) }
        LaunchedEffect(v.id) {
            if (!r.tiersKnown) {
                offers = try {
                    api.videoQualities(v.id, if (plan.auto) AUTO_QUALITY else plan.quality, plan.screen, app.host.decoders.codecsParam)
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    null // the usual chips stay
                }
            }
        }
        val shownPlan = offers?.takeIf { it.tiersKnown }?.let { withOffers(plan, it.qualities, it.codecs, app.host.decoders) } ?: plan
        val planNow by rememberUpdatedState(shownPlan)
        val fullscreenNow by rememberUpdatedState(fullscreen)
        val onFullscreenNow by rememberUpdatedState(onFullscreen)
        val onVideoNow by rememberUpdatedState(onVideo)
        val onChannelNow by rememberUpdatedState(onChannel)
        val laterNow by rememberUpdatedState(later)
        val listState = rememberLazyListState()
        val player = remember(v.id) {
            movableContentOf {
                val cur = latest
                // Computed when the player is mounted: if it is ever recreated it resumes from where it was, not from the first start.
                val begin = remember { resumeStart(resume[0], cur.progress, cur.video.durationSeconds ?: 0L) }
                if (showPlayer(cur.playable, cur.reason, override)) {
                    StreamPlayer(
                        cur.video, planNow.quality, planNow.chips, cur.lang, begin, onPosition = { resume[0] = it },
                        fullscreen = fullscreenNow, onFullscreen = { onFullscreenNow(it) }, initialAuto = planNow.auto, screenHeight = planNow.screen,
                    )
                } else {
                    Column(Modifier.padding(12.dp).semantics { liveRegion = LiveRegionMode.Polite }) {
                        Text(shortMessage(cur.message.ifBlank { "This video can't be played." }), color = MaterialTheme.colorScheme.error)
                        Button(onClick = { override = true }) { Text("Try anyway") }
                    }
                }
            }
        }
        val details = remember(v.id) {
            movableContentOf { modifier: Modifier ->
                val cur = latest
                val video = cur.video
                LazyColumn(modifier, state = listState, contentPadding = PaddingValues(bottom = 24.dp)) {
                    item {
                        Column(Modifier.padding(12.dp)) {
                            Text(video.title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                            WatchLaterButton(laterNow, video.id, video.title)
                            Text(
                                joinParts(video.channelTitle, timeAgo(video.publishedAt), formatViews(video.views), formatLikes(video.likes)),
                                color = LinkBlue,
                                modifier = Modifier.clickable(enabled = video.channelId.isNotEmpty()) { onChannelNow(video.channelId) }.padding(vertical = 6.dp),
                            )
                            if (video.description.isNotBlank()) {
                                Text(
                                    video.description, color = Muted, maxLines = if (expanded) Int.MAX_VALUE else 3, overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.clickable { expanded = !expanded },
                                )
                            }
                        }
                    }
                    // commentsOpen/commentsOrder are state delegates captured here, so this long-lived lambda always reads the current values.
                    commentsSection(comments, video.commentCount?.toLongOrNull(), commentsOpen, { commentsOpen = it }, commentsOrder, { commentsOrder = it })
                    if (cur.related.items.isNotEmpty()) item { SectionTitle(cur.related.heading.ifBlank { "Related videos" }) }
                    items(cur.related.items, key = { it.id }) { RelatedRow(it, onVideoNow, thumbWidth = 140, later = laterNow) }
                }
            }
        }
        if (twoPane) {
            Row(Modifier.fillMaxSize()) {
                // Its own scroll, so the controls stay reachable when the window is short; the right pane scrolls separately.
                Column(Modifier.weight(0.58f).fillMaxHeight().verticalScroll(rememberScrollState())) { player() }
                details(Modifier.weight(0.42f).fillMaxHeight())
            }
        } else {
            Column(Modifier.fillMaxWidth()) {
                // The player stays pinned at the top; everything else scrolls underneath it.
                player()
                if (!fullscreen && !inPip) details(Modifier)
            }
        }
    }
}
