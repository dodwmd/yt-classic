package io.github.dodwmd.ytclassic.player

import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import io.github.dodwmd.ytclassic.data.CueTrack
import io.github.dodwmd.ytclassic.data.SubTrack
import io.github.dodwmd.ytclassic.data.chooseLang
import io.github.dodwmd.ytclassic.data.parseVtt
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Where captions come from: the server (tracks, WebVTT) and the saved choice. Interfaces so the state machine runs in plain JVM tests. */
interface CaptionSource {
    suspend fun tracks(videoId: String, pref: String): List<SubTrack>
    suspend fun vtt(videoId: String, lang: String): String
}

interface CaptionPrefs {
    suspend fun on(): Boolean
    suspend fun lang(): String
    suspend fun save(on: Boolean, lang: String)
}

/** What the CC menu shows while the track list is not there yet. */
enum class TrackLoad { NotAsked, Loading, Loaded, Failed }

const val NOTICE_NO_SUBTITLES = "No subtitles for this video"
const val NOTICE_UNAVAILABLE = "Subtitles unavailable"

/**
 * Captions for one video. The track list is only asked for when the viewer first opens the CC menu, or when captions were
 * left on (it costs the server a yt-dlp run); the WebVTT only while captions are on. The text shown comes from the ABSOLUTE
 * position (the stream restarts at an offset on every seek), not from ExoPlayer's text renderer. A [notice] (an error or
 * "no subtitles") is kept apart from the cue [text], so changing state never erases it; the owner clears it on a timer.
 */
@Stable
class CaptionsState(
    private val videoId: String,
    private val source: CaptionSource,
    private val prefs: CaptionPrefs,
    private val deviceLang: String = "",
    private val parseOn: CoroutineDispatcher = Dispatchers.Default,
) {
    var tracks by mutableStateOf<List<SubTrack>>(emptyList())
        private set
    var load by mutableStateOf(TrackLoad.NotAsked)
        private set
    var lang by mutableStateOf("")
        private set
    var enabled by mutableStateOf(false)
        private set
    var text by mutableStateOf("")
        private set
    var notice by mutableStateOf("")
        private set

    /** Bumped when new cues arrive, so a ticking effect can restart. */
    var cueVersion by mutableIntStateOf(0)
        private set
    private var cues = CueTrack.EMPTY
    private var cachedLang: String? = null // the last track downloaded: switching off and on again does not fetch it again

    /** Reads the saved choice; when captions were left on, asks for the tracks now. */
    suspend fun start() {
        lang = prefs.lang()
        enabled = prefs.on()
        if (enabled) ensureTracks()
    }

    suspend fun ensureTracks() {
        if (load == TrackLoad.Loaded || load == TrackLoad.Loading) return
        load = TrackLoad.Loading
        try {
            val list = source.tracks(videoId, lang)
            tracks = list
            lang = chooseLang(lang, list, deviceLang) ?: ""
            load = TrackLoad.Loaded
            if (list.isEmpty() && enabled) {
                enabled = false
                notice = NOTICE_NO_SUBTITLES
            }
        } catch (e: CancellationException) {
            load = TrackLoad.NotAsked
            throw e
        } catch (_: Exception) {
            load = TrackLoad.Failed // asked again the next time the menu opens
            if (enabled) { enabled = false; notice = NOTICE_UNAVAILABLE }
        }
    }

    /** Downloads (or reuses) the chosen track when captions are on. A failure turns them off for now (not saved) and sets a [notice]. */
    suspend fun loadCues() {
        text = ""
        if (!enabled || load != TrackLoad.Loaded || tracks.isEmpty()) return
        if (cachedLang == lang) return bump(cues) // already parsed
        val track = tracks.firstOrNull { it.lang == lang } ?: return
        try {
            val vtt = source.vtt(videoId, lang)
            bump(CueTrack(withContext(parseOn) { parseVtt(vtt, track.auto) }))
            cachedLang = lang
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            enabled = false
            notice = NOTICE_UNAVAILABLE
        }
    }

    private fun bump(c: CueTrack) { cues = c; cueVersion++ }

    val hasCues get() = enabled && !cues.isEmpty

    fun tick(positionMs: Long) {
        if (hasCues) text = cues.textAt(positionMs)
    }

    fun clearNotice() { notice = "" }

    /** null turns captions off; a language turns them on in that language. Saved as the global choice (the language only when one is picked). */
    suspend fun choose(newLang: String?) {
        notice = ""
        enabled = newLang != null
        if (newLang != null) lang = newLang
        text = ""
        prefs.save(enabled, lang)
    }
}
