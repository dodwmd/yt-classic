package io.github.dodwmd.ytclassic.player

/** The optional controls of the transport row (play/pause, seek bar, time and fullscreen are always inline). */
enum class TransportItem { Speed, Captions, Pip, Skip, Stop }

/** Which optional controls fit inline and which move into the overflow menu. */
data class TransportPlan(val inline: List<TransportItem>, val overflow: List<TransportItem>)

/** Below this row width (dp, at normal font size) the optional controls no longer leave the seek bar any room. */
const val COMPACT_ROW_DP = 420f

/**
 * [widthDp] is the width the row really has (a two-pane layout gives the player only part of the screen); a larger font
 * scales the threshold, since the time text and the buttons grow with it. Compact rows keep only the essentials inline.
 */
fun transportPlan(widthDp: Float, fontScale: Float, pip: Boolean, tv: Boolean): TransportPlan {
    val all = buildList {
        add(TransportItem.Speed)
        add(TransportItem.Captions)
        if (pip) add(TransportItem.Pip)
        if (tv) { add(TransportItem.Skip); add(TransportItem.Stop) }
    }
    return if (widthDp < COMPACT_ROW_DP * maxOf(1f, fontScale)) TransportPlan(emptyList(), all) else TransportPlan(all, emptyList())
}
