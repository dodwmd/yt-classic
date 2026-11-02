package io.github.dodwmd.ytclassic.player

import androidx.annotation.OptIn
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import io.github.dodwmd.ytclassic.data.label
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.launch
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.material3.LocalContentColor
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.movableContentOf
import androidx.compose.ui.semantics.Role
import io.github.dodwmd.ytclassic.data.errorActions
import io.github.dodwmd.ytclassic.ui.LocalOpenSettings
import io.github.dodwmd.ytclassic.ui.classicSliderColors
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.foundation.relocation.bringIntoViewRequester
import androidx.compose.foundation.relocation.BringIntoViewRequester
import androidx.compose.runtime.SideEffect
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import android.graphics.Rect
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.media3.common.util.UnstableApi
import androidx.media3.ui.PlayerView
import io.github.dodwmd.ytclassic.App
import io.github.dodwmd.ytclassic.data.Chapter
import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.data.chapterIndexAt
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.material3.SliderDefaults
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.geometry.Offset
import io.github.dodwmd.ytclassic.data.formatSeconds
import io.github.dodwmd.ytclassic.data.Tiles
import io.github.dodwmd.ytclassic.data.locate
import androidx.compose.ui.graphics.ImageBitmap
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

/** The seek thumb's size: passed to the Slider and used to find where its track starts and ends (for the chapter ticks). */
private val SLIDER_THUMB = DpSize(4.dp, 44.dp)

/**
 * The player UI for [video]. Playback itself lives in [PlaybackHost], so it can continue in the background; this
 * shows its state and sends the seek bar, quality and retry actions to it (which restart the stream at an offset
 * through [StreamSeek]; the slider uses the real duration from the API).
 */
@OptIn(UnstableApi::class)
@kotlin.OptIn(androidx.compose.material3.ExperimentalMaterial3Api::class)
@Composable
fun StreamPlayer(
    video: VideoDetail,
    initialQuality: Int,
    qualities: List<Int>,
    lang: String,
    startSeconds: Long,
    onPosition: (Long) -> Unit,
    fullscreen: Boolean,
    onFullscreen: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    /** Chapter ticks on the seek bar and the current chapter's name next to the time. */
    chapters: List<Chapter> = emptyList(),
    /** TV: adds Skip and Stop buttons to the controls (used in fullscreen, where the buttons below the player are not visible). */
    onSkip: (() -> Unit)? = null,
    onStop: (() -> Unit)? = null,
    initialAuto: Boolean = false,
    /** The display's shorter side in px, as the plan used it: Auto picks the tallest chip that fits. */
    screenHeight: Int = 1080,
) {
    val app = LocalContext.current.applicationContext as App
    val host = app.host
    val reduceMotion = remember { Settings.Global.getFloat(app.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }
    val total = video.durationSeconds ?: 0L
    var positionSec by remember(video.id) { mutableLongStateOf(startSeconds) }
    var dragging by remember(video.id) { mutableStateOf<Float?>(null) }
    val isPlaying = host.isPlaying
    val finished = host.finished
    val quality = host.quality

    var controlsVisible by remember(video.id) { mutableStateOf(true) }
    val pip = LocalPip.current
    // The small window has no orientation lock or hidden bars; both come back when it is expanded.
    FullscreenEffect(fullscreen && !pip.inPip)
    BackHandler(enabled = fullscreen) { onFullscreen(false) }

    fun savePosition() { if (host.video?.id == video.id) onPosition(if (host.finished) 0 else host.positionSeconds()) }

    DisposableEffect(pip) { onDispose { pip.clearVideoBounds() } }
    DisposableEffect(video.id) {
        host.open(video, initialQuality, lang, startSeconds, initialAuto)
        onDispose {
            savePosition()
            host.leave(video.id) // stops, unless it is playing on in the background
        }
    }
    LifecycleEventEffect(Lifecycle.Event.ON_STOP) {
        host.onAppStopped() // pauses unless background audio is on and playing
        savePosition() // the process may be killed while we're in the background
    }

    LaunchedEffect(video.id) {
        while (true) {
            if (dragging == null && host.video?.id == video.id) positionSec = host.positionSeconds()
            delay(500)
        }
    }

    // Double tap on the left or right third seeks 10 s; further double taps within 700 ms add up and the stream is
    // restarted once, when they stop.
    val run = remember(video.id) { TapSeekRun() }
    var taps by remember(video.id) { mutableIntStateOf(0) }
    var overlay by remember(video.id) { mutableStateOf<Pair<TapZone, Long>?>(null) }
    LaunchedEffect(taps) {
        if (taps == 0) return@LaunchedEffect
        delay(TAP_ACCUMULATE_MS) // the run ends when the taps stop
        if (run.active && host.video?.id == video.id) host.load(run.target)
        run.finish()
        overlay = null
    }
    fun doubleTapAt(zone: TapZone) {
        if (zone == TapZone.Middle || total <= 0 || host.video?.id != video.id) return
        overlay = zone to run.add(zone, host.positionSeconds())
        taps++
    }
    // A seek from elsewhere (a chapter or timestamp tap) also ends a pending double-tap run.
    LaunchedEffect(host.loads) { if (run.active) { run.finish(); overlay = null } }
    // Any other seek replaces a pending double-tap run, so its stale target can't override it later.
    fun cancelRun() { run.finish(); overlay = null }
    fun jump(seconds: Long) { cancelRun(); host.load(host.positionSeconds() + seconds) }

    val captions = rememberCaptions(app.api, app.settings, video.id, isPlaying, positionSec) { host.positionMs() }
    val captionScope = rememberCoroutineScope()
    val textColor = if (fullscreen) Color.White else LocalContentColor.current
    val chapterName = chapters.getOrNull(chapterIndexAt(chapters, (dragging ?: positionSec.toFloat()).toLong()))?.title
    val sliderColors = classicSliderColors(overVideo = fullscreen)
    val sliderSource = remember { MutableInteractionSource() }
    // Scrub previews: the storyboard is asked for when a drag starts; the sheet with the dragged-to tile is decoded on demand.
    val scrub = remember(video.id) { scrubPreviewFor(app.api, video.id) }
    var tiles by remember(video.id) { mutableStateOf<Tiles?>(null) }
    val dragRect = dragging?.let { d -> tiles?.locate(d) }
    var sheet by remember(video.id) { mutableStateOf<Pair<Int, ImageBitmap>?>(null) }
    DisposableEffect(scrub) { onDispose { scrub.close() } }
    val isDragging = dragging != null && total > 0
    LaunchedEffect(scrub, isDragging) {
        if (isDragging) tiles = scrub.load()
        else { tiles = null; sheet = null } // a finished drag leaves no stale tile for the next one
    }
    LaunchedEffect(scrub, dragRect?.sheet) {
        val r = dragRect ?: return@LaunchedEffect
        scrub.sheet(r.sheet)?.let { sheet = r.sheet to it }
        scrub.prefetch(r.sheet + 1) // the neighbour, so crossing a sheet boundary has it ready
    }
    val fontScale = LocalDensity.current.fontScale
    val transport: @Composable () -> Unit = {
      // The row's real width decides what fits (a two-pane layout gives the player only part of the screen).
      BoxWithConstraints(Modifier.fillMaxWidth()) {
        val rowWidthDp = maxWidth.value
        Column(Modifier.fillMaxWidth()) {
            val plan = transportPlan(rowWidthDp, fontScale, pip.available, onSkip != null || onStop != null)
            val compact = plan.inline.isEmpty() && plan.overflow.isNotEmpty() // too narrow: the seek bar gets a row of its own
            val playBtn: @Composable () -> Unit = {
            TextButton(
                onClick = { if (isPlaying) host.pause() else host.play() },
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = if (finished) "Replay" else if (isPlaying) "Pause" else "Play" },
            ) { PlayerIconView(if (finished) PlayerIcon.Replay else if (isPlaying) PlayerIcon.Pause else PlayerIcon.Play, textColor, iconSize = if (finished) 36.dp else 28.dp) }
            }
            val seekBar: @Composable RowScope.() -> Unit = {
            if (total > 0) {
              Box(Modifier.weight(1f)) {
                Slider(
                    value = dragging ?: positionSec.toFloat(),
                    onValueChange = { dragging = it },
                    onValueChangeFinished = {
                        cancelRun()
                        dragging?.let { host.load(it.toLong()) }
                        dragging = null
                    },
                    valueRange = 0f..total.toFloat(),
                    colors = sliderColors,
                    interactionSource = sliderSource,
                    thumb = { SliderDefaults.Thumb(sliderSource, colors = sliderColors, thumbSize = SLIDER_THUMB) },
                    modifier = Modifier.fillMaxWidth().drawWithContent {
                        drawContent()
                        // Chapter ticks over the track: it spans the slider minus half a thumb on each side (the same thumb size is passed to the Slider).
                        if (chapters.size > 1) {
                            val inset = SLIDER_THUMB.width.toPx() / 2
                            val span = size.width - 2 * inset
                            val rtl = layoutDirection == LayoutDirection.Rtl
                            for (c in chapters) if (c.start > 0) {
                                val f = minOf(c.start, total).toFloat() / total
                                val x = inset + span * (if (rtl) 1f - f else f)
                                drawLine(Color.Black.copy(alpha = 0.5f), Offset(x, size.height / 2 - 7.dp.toPx()), Offset(x, size.height / 2 + 7.dp.toPx()), strokeWidth = 3.dp.toPx())
                                drawLine(Color.White.copy(alpha = 0.9f), Offset(x, size.height / 2 - 6.dp.toPx()), Offset(x, size.height / 2 + 6.dp.toPx()), strokeWidth = 1.5.dp.toPx())
                            }
                        }
                    }.semantics {
                        contentDescription = "Seek"
                        stateDescription = "${formatSeconds((dragging ?: positionSec.toFloat()).toLong())} of ${formatSeconds(total)}" + (chapterName?.let { ", chapter $it" } ?: "")
                    },
                )
                val at = dragging
                if (at != null && dragRect != null && tiles != null && !pip.inPip) {
                    val t = at.toLong()
                    ScrubBubble(tiles!!, dragRect, sheet?.takeIf { it.first == dragRect.sheet }?.second, at / total, formatSeconds(t), chapters.getOrNull(chapterIndexAt(chapters, t))?.title, with(LocalDensity.current) { SLIDER_THUMB.width.toPx().roundToInt() / 2 })
                }
              }
                Text("${formatSeconds((dragging ?: positionSec.toFloat()).toLong())} / ${formatSeconds(total)}", color = textColor, maxLines = 1, softWrap = false, modifier = Modifier.padding(horizontal = 8.dp))
            }
            }
            val tail: @Composable RowScope.() -> Unit = {
            var speedMenu by remember { mutableStateOf(false) }
            var ccMenu by remember { mutableStateOf(false) }
            var more by remember { mutableStateOf(false) }
            val openCc: () -> Unit = { ccMenu = true; captionScope.launch { captions.ensureTracks() } }
            // Inline: each optional control is its own button (its menu hangs off it). Compact: one overflow button
            // opens a menu of them, and the speed and CC menus then hang off that button too.
            @Composable fun speedMenuView() = SpeedMenu(speedMenu, { speedMenu = false }, host.speed) { speedMenu = false; host.changeSpeed(it) }
            @Composable fun ccMenuView() = CaptionMenu(ccMenu, { ccMenu = false }, captions) { ccMenu = false; captionScope.launch { captions.choose(it) } }
            if (TransportItem.Speed in plan.inline) Box {
                TextButton(
                    onClick = { speedMenu = true },
                    modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = "Playback speed ${speedLabel(host.speed)}" },
                ) { Text(speedLabel(host.speed), color = textColor) }
                speedMenuView()
            }
            if (TransportItem.Captions in plan.inline) Box {
                TextButton(
                    onClick = openCc,
                    modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics {
                        contentDescription = "Subtitles"
                        stateDescription = if (captions.enabled) "On" else "Off"
                    },
                ) { Text("CC", color = textColor, fontWeight = if (captions.enabled) FontWeight.Bold else FontWeight.Normal, textDecoration = if (captions.enabled) TextDecoration.Underline else null) }
                ccMenuView()
            }
            if (TransportItem.Skip in plan.inline && onSkip != null) TextButton(onClick = onSkip, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)) { Text("Skip", color = textColor) }
            if (TransportItem.Stop in plan.inline && onStop != null) TextButton(onClick = onStop, modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp)) { Text("Stop", color = textColor) }
            if (TransportItem.Pip in plan.inline) TextButton(
                onClick = pip.enter,
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = "Picture in picture" },
            ) { PlayerIconView(PlayerIcon.Pip, textColor) }
            if (plan.overflow.isNotEmpty()) Box {
                TextButton(
                    onClick = { more = true },
                    modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = "More controls" },
                ) { Text("\u22EE", color = textColor, fontSize = 20.sp) }
                DropdownMenu(expanded = more, onDismissRequest = { more = false }) {
                    for (item in plan.overflow) when (item) {
                        TransportItem.Speed -> DropdownMenuItem(text = { Text("Speed ${speedLabel(host.speed)}") }, onClick = { more = false; speedMenu = true })
                        TransportItem.Captions -> DropdownMenuItem(
                            text = { Text(if (captions.enabled) "Subtitles: on" else "Subtitles") },
                            onClick = { more = false; openCc() },
                        )
                        TransportItem.Pip -> DropdownMenuItem(text = { Text("Picture in picture") }, onClick = { more = false; pip.enter() })
                        TransportItem.Skip -> if (onSkip != null) DropdownMenuItem(text = { Text("Skip") }, onClick = { more = false; onSkip() })
                        TransportItem.Stop -> if (onStop != null) DropdownMenuItem(text = { Text("Stop") }, onClick = { more = false; onStop() })
                    }
                }
                speedMenuView()
                ccMenuView()
            }
            TextButton(
                onClick = { controlsVisible = true; onFullscreen(!fullscreen) }, // hidden controls must not outlive a fullscreen session
                modifier = Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp).semantics { contentDescription = if (fullscreen) "Exit fullscreen" else "Fullscreen" },
            ) { PlayerIconView(if (fullscreen) PlayerIcon.ExitFullscreen else PlayerIcon.Fullscreen, textColor) }
            }
            if (compact) Column(Modifier.fillMaxWidth().padding(horizontal = 4.dp)) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { seekBar() }
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) { playBtn(); Spacer(Modifier.weight(1f)); tail() }
            } else Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) { playBtn(); seekBar(); tail() }
            if (chapterName != null && total > 0) Text(chapterName, color = textColor, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 12.dp))
        }
      }
    }
    // One PlayerView for both layouts: movable content moves the same view instead of building a second one (the
    // surface may still redraw for a frame when it is re-attached).
    val videoView = remember(host) { movableContentOf { m: Modifier, overlay: Pair<TapZone, Long>?, taps: Int, cap: Pair<String, Dp> ->
        Box(m.onGloballyPositioned {
            val r = it.boundsInWindow()
            // The picture inside the view (not the black bars), as the transition's source.
            val size = host.videoSize
            val f = fittedRect(r.left.toInt(), r.top.toInt(), r.width.toInt(), r.height.toInt(), pipAspect(size.width, size.height, size.pixelWidthHeightRatio))
            pip.setVideoBounds(Rect(f.left, f.top, f.right, f.bottom))
        }) {
            AndroidView(
                factory = { ctx -> PlayerView(ctx).apply { useController = false } },
                update = { it.player = host.player },
                onRelease = { it.player = null },
                modifier = Modifier.matchParentSize(),
            )
            overlay?.let { (zone, delta) -> TapSeekOverlay(zone, delta, taps, reduceMotion, Modifier.align(if (zone == TapZone.Back) Alignment.CenterStart else Alignment.CenterEnd)) }
            if (!pip.inPip) CaptionOverlay(cap.first, fullscreen, cap.second, Modifier.align(Alignment.BottomCenter))
            if (host.buffering && host.error == null) CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            host.error?.let { message ->
                Column(
                    Modifier.align(Alignment.Center).verticalScroll(rememberScrollState()).padding(16.dp)
                        .semantics { liveRegion = LiveRegionMode.Polite }, // TalkBack reads why playback failed
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Text(message, color = Color.White)
                    if (host.needsToken && !pip.inPip) {
                        val openSettings = LocalOpenSettings.current
                        Button(onClick = openSettings) { Text("Open Settings") }
                    }
                    val actions = errorActions(host.errorCode, host.errorRetryable)
                    actions.hint?.let { Text(it, color = Color.White.copy(alpha = 0.8f)) }
                    if (actions.showRetry && !pip.inPip) Button(onClick = { host.retry() }) { Text("Retry") }
                }
            }
        }
    } }

    // Taps on the video (read through rememberUpdatedState: the pointer block lives as long as its key, and in TV mode
    // this composable stays while the video changes): a double tap seeks (above); in fullscreen a single tap shows or hides the controls.
    // TalkBack gets the same as actions on the video, since it can't double tap a third of the screen.
    val onTap by rememberUpdatedState { if (fullscreen) controlsVisible = !controlsVisible }
    val onDoubleTap by rememberUpdatedState { zone: TapZone -> doubleTapAt(zone) }
    val gestures = Modifier
        .pointerInput(video.id) {
            detectTapGestures(
                onTap = { onTap() },
                onDoubleTap = { onDoubleTap(tapZone(it.x, size.width.toFloat())) },
            )
        }
        .semantics {
            if (fullscreen || pip.inPip) {
                role = Role.Button
                onClick(if (controlsVisible) "Hide controls" else "Show controls") { controlsVisible = !controlsVisible; true }
            }
            if (total > 0) customActions = listOf(
                CustomAccessibilityAction("Rewind 10 seconds") { jump(-TAP_SEEK_SECONDS); true },
                CustomAccessibilityAction("Forward 10 seconds") { jump(TAP_SEEK_SECONDS); true },
            )
        }

    if (fullscreen || pip.inPip) {
        // The video fills the screen; tap it to show or hide the controls laid over the bottom.
        Box(modifier.fillMaxSize().background(Color.Black)) {
            videoView(
                // In the small window the system owns taps (they show its own buttons): no gesture or click target there.
                if (pip.inPip) Modifier.fillMaxSize() else Modifier.fillMaxSize().then(gestures).semantics { contentDescription = "Video" },
                overlay, taps, captions.notice.ifEmpty { captions.text } to (if (controlsVisible) 64.dp else 0.dp),
            )
            if (controlsVisible && !pip.inPip) {
                Column(
                    Modifier.align(Alignment.BottomCenter).fillMaxWidth().background(Color.Black.copy(alpha = 0.7f))
                        .windowInsetsPadding(WindowInsets.safeDrawing),
                ) { transport() }
            }
        }
    } else {
        Column(modifier) {
            // In landscape a full-width 16:9 box would fill the screen; cap its height so the details stay reachable.
            val maxHeight = with(LocalDensity.current) { (LocalWindowInfo.current.containerSize.height * 0.6f).toDp() }
            Box(Modifier.fillMaxWidth().background(Color.Black), contentAlignment = Alignment.Center) {
                videoView(Modifier.heightIn(max = maxHeight).aspectRatio(16f / 9f).then(if (pip.inPip) Modifier else gestures), overlay, taps, captions.notice.ifEmpty { captions.text } to 0.dp)
            }
            transport()
            // Scrolls sideways when the tiers (up to 2160p, and Auto) do not fit a narrow screen.
            val chips = qualities.filter { it <= host.ceiling } // a tier this device failed to decode is gone for this video
            SideEffect { host.chips = chips }
            val shown = chipFor(chips, quality) // the video may lack the exact tier that was asked for
            Row(
                Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 8.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (q in chips) QualityChip("${q}p", !host.auto && q == shown, null) { host.chooseQuality(q, false) }
                if (chips.size > 1) {
                    val label = if (host.auto) "Auto ${shown}p" else "Auto (max for screen)"
                    QualityChip(label, host.auto, if (host.auto) "Automatic, ${shown}p" else "Off") { host.chooseQuality(autoTier(chips, screenHeight), true) }
                }
            }
            host.qualityNotice?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 12.dp).semantics { liveRegion = LiveRegionMode.Polite }) }
        }
    }
}

/** One quality chip; the selected one scrolls into view in the row, and [state] is what TalkBack reads after the label. */
@Composable
private fun QualityChip(label: String, selected: Boolean, state: String?, onClick: () -> Unit) {
    val requester = remember { BringIntoViewRequester() }
    LaunchedEffect(selected) { if (selected) requester.bringIntoView() }
    FilterChip(
        selected = selected, onClick = onClick, label = { Text(label) },
        modifier = Modifier.bringIntoViewRequester(requester).then(if (state != null) Modifier.semantics { stateDescription = state } else Modifier),
    )
}

/** "-10" / "+10" (running total) on the side that was double tapped, with a fading ripple unless animations are off. */
@Composable
private fun TapSeekOverlay(zone: TapZone, delta: Long, taps: Int, reduceMotion: Boolean, modifier: Modifier) {
    val ripple = remember { Animatable(0f) }
    LaunchedEffect(taps) {
        if (reduceMotion) return@LaunchedEffect
        ripple.snapTo(0.5f)
        ripple.animateTo(0f, tween(600))
    }
    Box(modifier.padding(horizontal = 24.dp), contentAlignment = Alignment.Center) {
        Box(Modifier.size(96.dp).alpha(ripple.value).clip(CircleShape).background(Color.White))
        Text(
            (if (delta > 0) "+" else "") + delta, color = Color.White,
            modifier = Modifier.clip(RoundedCornerShape(24.dp)).background(Color.Black.copy(alpha = 0.7f)).padding(horizontal = 14.dp, vertical = 8.dp)
                .semantics { liveRegion = LiveRegionMode.Polite; contentDescription = (if (delta > 0) "Forward " else "Rewind ") + kotlin.math.abs(delta) + " seconds" },
        )
    }
}

@Composable
private fun SpeedMenu(expanded: Boolean, onDismiss: () -> Unit, current: Float, onPick: (Float) -> Unit) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        for (s in PLAYBACK_SPEEDS) {
            DropdownMenuItem(
                text = { Text(speedLabel(s)) },
                onClick = { onPick(s) }, // applies it and keeps it as the global default
                modifier = Modifier.semantics { role = Role.RadioButton; selected = s == current; stateDescription = if (s == current) "Selected" else "Not selected" },
            )
        }
    }
}

/** Off plus the tracks; the list is fetched the first time this opens, so the menu says so while it waits and when there is nothing. */
@Composable
private fun CaptionMenu(expanded: Boolean, onDismiss: () -> Unit, captions: CaptionsState, onPick: (String?) -> Unit) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        DropdownMenuItem(
            text = { Text("Off") },
            onClick = { onPick(null) },
            modifier = Modifier.semantics { role = Role.RadioButton; selected = !captions.enabled; stateDescription = if (!captions.enabled) "Selected" else "Not selected" },
        )
        when {
            captions.load == TrackLoad.Loading || captions.load == TrackLoad.NotAsked -> DropdownMenuItem(text = { Text("Loading\u2026") }, onClick = {}, enabled = false)
            captions.load == TrackLoad.Failed -> DropdownMenuItem(text = { Text(NOTICE_UNAVAILABLE) }, onClick = {}, enabled = false)
            captions.tracks.isEmpty() -> DropdownMenuItem(text = { Text(NOTICE_NO_SUBTITLES) }, onClick = {}, enabled = false)
            else -> for (t in captions.tracks) {
                val on = captions.enabled && t.lang == captions.lang
                DropdownMenuItem(
                    text = { Text(t.label()) },
                    onClick = { onPick(t.lang) },
                    modifier = Modifier.semantics { role = Role.RadioButton; selected = on; stateDescription = if (on) "Selected" else "Not selected" },
                )
            }
        }
    }
}
