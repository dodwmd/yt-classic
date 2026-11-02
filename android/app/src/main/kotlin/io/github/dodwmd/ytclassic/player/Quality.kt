package io.github.dodwmd.ytclassic.player

import android.content.Context
import android.media.MediaCodecList
import io.github.dodwmd.ytclassic.data.VideoResponse
import kotlin.math.min

/** The stored preference value for "Auto" (the other values are heights in pixels). */
const val AUTO_QUALITY = 0

private val TIERS = listOf(360, 480, 720, 1080, 1440, 2160)
private val FAMILIES = listOf("avc1", "vp9", "av1")

/**
 * What this device can decode in hardware: the tallest 16:9 size per codec family (as the server names them: "avc1",
 * "vp9", "av1"); a family that is absent is not offered. The server's tiers above 1080p are VP9 or AV1 only.
 */
data class Decoders(val maxHeight: Map<String, Int>) {
    /** The `codecs=` value for the server, in its order; H.264 when nothing is known (every device has it). */
    val codecsParam: String get() = FAMILIES.filter { (maxHeight[it] ?: 0) > 0 }.joinToString(",").ifEmpty { "avc1" }

    /** Can this device play [tier], given the codec families the server found at that tier (null: no hint)? */
    fun canPlay(tier: Int, offered: List<String>?): Boolean {
        val families = offered?.takeIf { it.isNotEmpty() } ?: if (tier > 1080) listOf("vp9", "av1") else listOf("avc1")
        return families.any { (maxHeight[it] ?: 0) >= tier }
    }
}

/** The chips to show: the server's tiers that this device can decode (never empty while the server offers anything). */
fun qualityChips(serverQualities: List<Int>, serverCodecs: Map<String, List<String>>, decoders: Decoders): List<Int> =
    serverQualities.filter { decoders.canPlay(it, serverCodecs[it.toString()]) }
        .ifEmpty { serverQualities.filter { it <= 1080 }.ifEmpty { serverQualities.take(1) } }

/** Auto: the tallest chip that fits the display's shorter side (in pixels), at least the lowest chip. */
fun autoTier(chips: List<Int>, screenHeight: Int): Int =
    chips.filter { it <= maxOf(screenHeight, TIERS.first()) }.maxOrNull() ?: chips.minOrNull() ?: 720

/** What to start playing: [quality] (a chip), and whether the user is on Auto. */
data class QualityPlan(val chips: List<Int>, val quality: Int, val auto: Boolean)

/**
 * The plan for a loaded video. [pref] is the stored choice ([AUTO_QUALITY], a height, or null when never chosen, in which
 * case the server's own default stands). A preferred height the video or device lacks falls back to the best chip below it.
 */
fun qualityPlan(r: VideoResponse, pref: Int?, decoders: Decoders, screenHeight: Int): QualityPlan {
    val chips = qualityChips(r.qualities, r.codecs, decoders)
    if (chips.isEmpty()) return QualityPlan(chips, r.quality, false)
    if (pref == AUTO_QUALITY) return QualityPlan(chips, autoTier(chips, screenHeight), true)
    val want = pref ?: r.quality
    return QualityPlan(chips, chips.filter { it <= want }.maxOrNull() ?: chips.min(), false)
}

/** The hardware decoders of this device (software ones are too slow for the sizes this matters for). */
fun deviceDecoders(): Decoders {
    val mimes = mapOf("avc1" to "video/avc", "vp9" to "video/x-vnd.on2.vp9", "av1" to "video/av01")
    val found = try {
        val infos = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder && !it.name.startsWith("OMX.google.") && !it.name.startsWith("c2.android.") }
        mimes.mapValues { (_, mime) ->
            infos.filter { info -> info.supportedTypes.any { it.equals(mime, ignoreCase = true) } }.maxOfOrNull { info ->
                try {
                    val caps = info.getCapabilitiesForType(mime).videoCapabilities
                    TIERS.filter { caps?.isSizeSupported(it * 16 / 9, it) == true }.maxOrNull() ?: 0
                } catch (_: IllegalArgumentException) {
                    0
                }
            } ?: 0
        }
    } catch (_: RuntimeException) {
        emptyMap()
    }
    // Every device plays H.264 up to 1080p; trust nothing less if the query came back empty.
    return Decoders(found + ("avc1" to maxOf(found["avc1"] ?: 0, 1080)))
}

/** The display's shorter side in pixels: the height of a landscape video that fills the screen. */
fun screenShortSide(context: Context): Int = context.resources.displayMetrics.let { min(it.widthPixels, it.heightPixels) }
