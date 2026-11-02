package io.github.dodwmd.ytclassic.player

import android.graphics.BitmapFactory
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import android.graphics.Bitmap
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntRect
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Popup
import androidx.compose.ui.window.PopupPositionProvider
import androidx.compose.ui.window.PopupProperties
import io.github.dodwmd.ytclassic.data.TileRect
import io.github.dodwmd.ytclassic.data.Tiles
import io.github.dodwmd.ytclassic.data.YtApi
import io.github.dodwmd.ytclassic.data.bubbleLeft
import io.github.dodwmd.ytclassic.data.sampleSizeFor
import kotlin.math.roundToInt

private const val MAX_TILE_DP = 160
private const val MIN_TILE_DP = 96

/** The app's storyboard source: the token-aware API client, and sheets decoded with BitmapFactory (a corrupt or oversized image is just no preview). */
fun scrubPreviewFor(api: YtApi, videoId: String) = ScrubPreview<ImageBitmap>(
    videoId,
    object : StoryboardSource {
        override suspend fun storyboard(videoId: String) = api.storyboard(videoId)
        override suspend fun sheet(videoId: String, n: Int) = api.storyboardSheet(videoId, n)
    },
    decode = ::decodeSheet,
    sizeOf = { it.width.toLong() * it.height * 2 },
)

/** Decodes a sheet as RGB_565 (half the memory), after reading its size: too large a side is refused, a big one is sampled down. */
internal fun decodeSheet(bytes: ByteArray, tiles: Tiles): ImageBitmap? {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
    val sample = sampleSizeFor(bounds.outWidth, bounds.outHeight, tiles.w) ?: return null
    val opts = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.RGB_565 }
    return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)?.asImageBitmap()
}

/**
 * The preview above the slider thumb while dragging: the tile [rect] cropped from [sheet] (just a dark box until the sheet
 * arrives) with the [time] and, when there is one, the [chapter] name. Small tiles are scaled up to a readable width. The time
 * is never shortened, the chapter name is. It floats over the video, so it works inline and in fullscreen; [frac] is where the
 * thumb is along the track, which starts [insetPx] into the slider. Decoration only: the slider already announces the time to
 * TalkBack. Nothing animates, so there is nothing to reduce.
 */
@Composable
fun ScrubBubble(tiles: Tiles, rect: TileRect, sheet: ImageBitmap?, frac: Float, time: String, chapter: String?, insetPx: Int) {
    val width = tiles.w.coerceIn(MIN_TILE_DP, MAX_TILE_DP)
    val height = (width.toFloat() * tiles.h / tiles.w).roundToInt()
    Popup(popupPositionProvider = BubblePosition(frac, insetPx), properties = PopupProperties(focusable = false, clippingEnabled = false)) {
        val shape = RoundedCornerShape(4.dp)
        Column(
            Modifier.clip(shape).background(Color.Black).border(2.dp, Color.White, shape).clearAndSetSemantics { },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            Canvas(Modifier.size(width.dp, height.dp)) {
                if (sheet == null) drawRect(Color(0xFF222222))
                else {
                    // A sampled-down sheet is smaller than the descriptor says: the tile moves with it.
                    val k = sheet.width.toFloat() / (tiles.cols * tiles.w)
                    drawImage(
                        sheet, IntOffset((rect.x * k).roundToInt(), (rect.y * k).roundToInt()), IntSize((rect.w * k).roundToInt(), (rect.h * k).roundToInt()),
                        dstSize = IntSize(size.width.roundToInt(), size.height.roundToInt()),
                    )
                }
            }
            Row(Modifier.widthIn(min = width.dp).padding(horizontal = 4.dp, vertical = 2.dp), horizontalArrangement = Arrangement.Center) {
                Text(time, color = Color.White, fontSize = 12.sp, maxLines = 1, softWrap = false)
                if (chapter != null) Text(" $chapter", color = Color.White, fontSize = 12.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = (width - 40).dp))
            }
        }
    }
}

private class BubblePosition(private val frac: Float, private val insetPx: Int) : PopupPositionProvider {
    override fun calculatePosition(anchorBounds: IntRect, windowSize: IntSize, layoutDirection: LayoutDirection, popupContentSize: IntSize): IntOffset {
        val f = if (layoutDirection == LayoutDirection.Rtl) 1f - frac else frac
        val x = bubbleLeft(anchorBounds.left, anchorBounds.width, insetPx, f, popupContentSize.width, windowSize.width)
        return IntOffset(x, (anchorBounds.top - popupContentSize.height).coerceAtLeast(0))
    }
}
