package io.github.dodwmd.ytclassic.player

import io.github.dodwmd.ytclassic.data.Progress

/**
 * Where to start a video. [local] is the position remembered by this screen (also the explicit start of the
 * navigation route): it only exists when the screen was just left, so it is newer than anything on the server and
 * also works offline. Otherwise the server's position, unless the video was finished (then it starts over).
 */
fun resumeStart(local: Long, progress: Progress?): Long = when {
    local > 0 -> local
    progress != null && !progress.completed && progress.position > 0 -> progress.position
    else -> 0L
}

/** Progress is reported when the position changed, and always for the final "finished" report. */
fun shouldReport(position: Long, lastReported: Long, finished: Boolean): Boolean = finished || position != lastReported
