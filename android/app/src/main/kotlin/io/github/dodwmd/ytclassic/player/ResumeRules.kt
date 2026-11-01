package io.github.dodwmd.ytclassic.player

import io.github.dodwmd.ytclassic.data.Progress

/** Watched to within this many seconds of the end counts as finished (the server uses the same rule). */
const val END_SLACK_SECONDS = 10L

/**
 * Where to start a video. [local] is the position remembered by this screen (also the explicit start of the
 * navigation route): it only exists when the screen was just left, so it is newer than anything on the server and
 * also works offline. Otherwise the server's position, unless the video was finished (then it starts over).
 * Without a known [durationSeconds] the stream cannot be restarted at an offset, so it starts at 0; so does a
 * position within [END_SLACK_SECONDS] of the end.
 */
fun resumeStart(local: Long, progress: Progress?, durationSeconds: Long): Long {
    val start = when {
        local > 0 -> local
        progress != null && !progress.completed && progress.position > 0 -> progress.position
        else -> 0L
    }
    return if (durationSeconds <= 0 || start >= durationSeconds - END_SLACK_SECONDS) 0L else start
}

/** Progress is reported when the position changed, and always for the final "finished" report. */
fun shouldReport(position: Long, lastReported: Long, finished: Boolean): Boolean = finished || position != lastReported

/**
 * The player stopped playing. Only a real pause counts: rebuffering or losing audio focus also clear isPlaying but
 * leave playWhenReady set, and a pending restart (a seek) is not a stop either.
 */
fun reportsOnPause(isPlaying: Boolean, playWhenReady: Boolean, restarting: Boolean): Boolean = !isPlaying && !playWhenReady && !restarting
