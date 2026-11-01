package io.github.dodwmd.ytclassic.player

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// Transport icons drawn in code: font glyphs like ⤢ or ↻ are missing or tiny in some OEM fonts. Decorative; the
// button around them carries the contentDescription.
enum class PlayerIcon { Play, Pause, Replay, Fullscreen, ExitFullscreen }

@Composable
fun PlayerIconView(icon: PlayerIcon, tint: Color, modifier: Modifier = Modifier, iconSize: Dp = 28.dp) {
    Canvas(modifier.size(iconSize)) {
        val s = size.minDimension
        val w = s * 0.09f
        val line = Stroke(w, cap = StrokeCap.Round, join = StrokeJoin.Round)
        when (icon) {
            PlayerIcon.Play -> drawPath(
                Path().apply { moveTo(s * 0.25f, s * 0.15f); lineTo(s * 0.85f, s * 0.5f); lineTo(s * 0.25f, s * 0.85f); close() },
                tint,
            )
            PlayerIcon.Pause -> {
                drawRect(tint, Offset(s * 0.2f, s * 0.15f), Size(s * 0.2f, s * 0.7f))
                drawRect(tint, Offset(s * 0.6f, s * 0.15f), Size(s * 0.2f, s * 0.7f))
            }
            PlayerIcon.Replay -> {
                // An open circle with a gap at the top and an arrowhead at the clockwise end.
                drawArc(tint, startAngle = -60f, sweepAngle = 300f, useCenter = false, topLeft = Offset(s * 0.15f, s * 0.2f), size = Size(s * 0.7f, s * 0.7f), style = Stroke(w * 1.4f, cap = StrokeCap.Butt))
                drawPath(
                    Path().apply { moveTo(s * 0.5f, s * 0.1f); lineTo(s * 0.385f, s * 0.36f); lineTo(s * 0.25f, s * 0.13f); close() },
                    tint,
                )
            }
            PlayerIcon.Fullscreen -> corners(tint, line, s, outward = true)
            PlayerIcon.ExitFullscreen -> corners(tint, line, s, outward = false)
        }
    }
}

private fun androidx.compose.ui.graphics.drawscope.DrawScope.corners(tint: Color, line: Stroke, s: Float, outward: Boolean) {
    val a = if (outward) 0.12f else 0.36f // distance of each bracket's corner from the edge
    val b = if (outward) 0.26f else 0.14f // length of the arms
    fun corner(cx: Float, cy: Float, dx: Float, dy: Float) {
        // dx/dy point from the corner along the arms.
        drawPath(Path().apply { moveTo(cx + dx * b * s, cy); lineTo(cx, cy); lineTo(cx, cy + dy * b * s) }, tint, style = line)
    }
    if (outward) {
        corner(a * s, a * s, 1f, 1f); corner((1 - a) * s, a * s, -1f, 1f)
        corner(a * s, (1 - a) * s, 1f, -1f); corner((1 - a) * s, (1 - a) * s, -1f, -1f)
    } else {
        // Brackets sit inside and their arms point to the outside.
        corner(a * s, a * s, -1f, -1f); corner((1 - a) * s, a * s, 1f, -1f)
        corner(a * s, (1 - a) * s, -1f, 1f); corner((1 - a) * s, (1 - a) * s, 1f, 1f)
    }
}
