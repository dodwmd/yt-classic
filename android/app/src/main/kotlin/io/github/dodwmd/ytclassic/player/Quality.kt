package io.github.dodwmd.ytclassic.player

import android.content.Context
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build
import androidx.media3.common.PlaybackException
import io.github.dodwmd.ytclassic.data.VideoResponse
import kotlin.math.min

/** The stored preference value for "Auto" (the other values are heights in pixels). */
const val AUTO_QUALITY = 0

private val TIERS = listOf(360, 480, 720, 1080, 1440, 2160)

/** All tiers the server knows, lowest first. */
val TIER_LIST: List<Int> get() = TIERS
private val FAMILIES = listOf("avc1", "vp9", "av1")

/**
 * What this device can decode in hardware: the tallest 16:9 size per codec family (as the server names them: "avc1",
 * "vp9", "av1"); a family that is absent is not offered. The server's tiers above 1080p are VP9 or AV1 only.
 */
data class Decoders(val maxHeight: Map<String, Int>) {
    /** The `codecs=` value for the server, in its order; H.264 when nothing is known (every device has it). */
    val codecsParam: String get() = FAMILIES.filter { (maxHeight[it] ?: 0) > 0 }.joinToString(",").ifEmpty { "avc1" }

    /** The tallest tier any decoder here handles (at least 1080). */
    val best: Int get() = maxOf(maxHeight.values.maxOrNull() ?: 0, 1080)

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

/** The chip that stands for [quality]: the tallest chip not above it (the video may lack the exact tier), else the lowest. */
fun chipFor(chips: List<Int>, quality: Int): Int? = chips.filter { it <= quality }.maxOrNull() ?: chips.minOrNull()

/** The chip below [current], or null at the bottom: where a tier the decoder choked on steps down to. */
fun nextLowerChip(chips: List<Int>, current: Int): Int? = chips.filter { it < current }.maxOrNull()

/** Errors that mean this device cannot decode the stream it was given (so a lower tier may work, and a retry will not). */
fun isDecoderFailure(errorCode: Int): Boolean =
    errorCode == PlaybackException.ERROR_CODE_DECODER_INIT_FAILED ||
        errorCode == PlaybackException.ERROR_CODE_DECODING_FAILED ||
        errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES

/** The tallest tier at or below [quality] that a decoder here handles (no hints from the server, e.g. for TV picks). */
fun playableTier(quality: Int, decoders: Decoders): Int =
    TIERS.filter { it <= quality && decoders.canPlay(it, null) }.maxOrNull() ?: TIERS.first()

/** What to start playing: [quality], whether the user is on Auto, the chips to show and the screen height Auto used. */
data class QualityPlan(val chips: List<Int>, val quality: Int, val auto: Boolean, val screen: Int = 1080)

/**
 * The plan for a loaded video. [pref] is the stored choice ([AUTO_QUALITY], a height, or null when never chosen, in which
 * case the server's own default stands). A preferred height the video or device lacks falls back to the best tier below it.
 * While the video's real tiers are not known yet ([VideoResponse.tiersKnown] false) every tier this device decodes is a
 * candidate to start at (the server falls back to what exists) and the chips show the usual ones; [withOffers] updates them.
 */
fun qualityPlan(r: VideoResponse, pref: Int?, decoders: Decoders, screenHeight: Int): QualityPlan {
    val screen = min(screenHeight, decoders.best) // a screen taller than any decoder cannot use more
    val chips = qualityChips(r.qualities, r.codecs, decoders)
    val candidates = if (r.tiersKnown) chips else qualityChips(TIERS, emptyMap(), decoders)
    if (candidates.isEmpty()) return QualityPlan(chips, r.quality, false, screen)
    if (pref == AUTO_QUALITY) return QualityPlan(chips, autoTier(candidates, screen), true, screen)
    val want = pref ?: r.quality
    return QualityPlan(chips, chipFor(candidates, want) ?: r.quality, false, screen)
}

/** The same plan once the video's real tiers are known: only the chips change (playback is already running). */
fun withOffers(plan: QualityPlan, qualities: List<Int>, codecs: Map<String, List<String>>, decoders: Decoders): QualityPlan =
    plan.copy(chips = qualityChips(qualities, codecs, decoders))

/** One decoder as the selection sees it, so the choice can be tested without a device. */
class CodecInfoLite(val name: String, val types: Set<String>, val hardware: Boolean, val supports: (mime: String, tier: Int) -> Boolean)

private val MIMES = mapOf("avc1" to "video/avc", "vp9" to "video/x-vnd.on2.vp9", "av1" to "video/av01")

/**
 * The tallest tier per codec family among the hardware, non-secure decoders. Every device plays H.264 up to 1080p,
 * so nothing less is reported for it even if the query came back empty.
 */
fun selectDecoders(infos: List<CodecInfoLite>): Decoders {
    val usable = infos.filter { it.hardware && !it.name.contains(".secure", ignoreCase = true) }
    val found = MIMES.mapValues { (_, mime) ->
        usable.filter { i -> i.types.any { it.equals(mime, ignoreCase = true) } }
            .maxOfOrNull { i -> TIERS.filter { i.supports(mime, it) }.maxOrNull() ?: 0 } ?: 0
    }
    return Decoders(found + ("avc1" to maxOf(found["avc1"] ?: 0, 1080)))
}

/** The device's decoders via MediaCodecList: API 29+ asks for hardware directly, older versions go by the vendor-free names. */
fun deviceDecoders(): Decoders = try {
    val infos = MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.filter { !it.isEncoder }.map { info ->
        val hardware = if (Build.VERSION.SDK_INT >= 29) !info.isSoftwareOnly && info.isHardwareAccelerated
        else !info.name.startsWith("OMX.google.") && !info.name.startsWith("c2.android.")
        CodecInfoLite(info.name, info.supportedTypes.toSet(), hardware) { mime, tier -> sizeSupported(info, mime, tier) }
    }
    selectDecoders(infos)
} catch (_: RuntimeException) {
    selectDecoders(emptyList())
}

private fun sizeSupported(info: MediaCodecInfo, mime: String, tier: Int): Boolean = try {
    info.getCapabilitiesForType(mime).videoCapabilities?.areSizeAndRateSupported(tier * 16 / 9, tier, 30.0) == true
} catch (_: IllegalArgumentException) {
    false
}

/** The display's shorter side in pixels: the height of a landscape video that fills the screen. */
fun screenShortSide(context: Context): Int = context.resources.displayMetrics.let { min(it.widthPixels, it.heightPixels) }
