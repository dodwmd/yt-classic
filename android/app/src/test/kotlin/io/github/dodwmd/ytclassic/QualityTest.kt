package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.data.VideoResponse
import io.github.dodwmd.ytclassic.player.AUTO_QUALITY
import io.github.dodwmd.ytclassic.player.Decoders
import androidx.media3.common.PlaybackException
import io.github.dodwmd.ytclassic.player.CodecInfoLite
import io.github.dodwmd.ytclassic.player.autoTier
import io.github.dodwmd.ytclassic.player.chipFor
import io.github.dodwmd.ytclassic.player.isDecoderFailure
import io.github.dodwmd.ytclassic.player.nextLowerChip
import io.github.dodwmd.ytclassic.player.playableTier
import io.github.dodwmd.ytclassic.player.selectDecoders
import io.github.dodwmd.ytclassic.player.withOffers
import io.github.dodwmd.ytclassic.player.qualityChips
import io.github.dodwmd.ytclassic.player.qualityPlan
import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

class QualityTest {
    private val all = listOf(360, 480, 720, 1080, 1440, 2160)
    // The codec hints the backend printed for a real 4K video (aqz-KE-bpKQ): H.264 stops at 1080p.
    private val codecs = mapOf(
        "360" to listOf("avc1", "vp9", "av1"), "480" to listOf("avc1", "vp9", "av1"), "720" to listOf("avc1", "vp9", "av1"),
        "1080" to listOf("avc1", "vp9", "av1"), "1440" to listOf("vp9", "av1"), "2160" to listOf("vp9", "av1"),
    )
    private val phone4k = Decoders(mapOf("avc1" to 2160, "vp9" to 2160, "av1" to 0))
    private val oldPhone = Decoders(mapOf("avc1" to 1080))
    private val vp9To1440 = Decoders(mapOf("avc1" to 1080, "vp9" to 1440))

    private fun response(q: Int = 720, qualities: List<Int> = all, codecs: Map<String, List<String>> = this.codecs, known: Boolean = true) =
        Json.decodeFromString<VideoResponse>("""{"video":{"id":"abc","title":"t"},"quality":$q,"qualities":${qualities},"codecs":${Json.encodeToString(codecs)},"tiersKnown":$known}""")

    @Test
    fun chipsAreTheServerTiersTheDeviceCanDecode() {
        assertEquals(all, qualityChips(all, codecs, phone4k))
        assertEquals(listOf(360, 480, 720, 1080), qualityChips(all, codecs, oldPhone), "H.264 only: nothing above 1080p")
        assertEquals(listOf(360, 480, 720, 1080, 1440), qualityChips(all, codecs, vp9To1440), "the decoder's own size limit")
        // AV1 only at 2160 and a device with only an AV1 decoder
        assertEquals(listOf(1080, 2160), qualityChips(listOf(1080, 2160), mapOf("2160" to listOf("av1")), Decoders(mapOf("avc1" to 1080, "av1" to 2160))))
    }

    @Test
    fun withoutHintsOldServersKeepTheirList() {
        val old = listOf(360, 480, 720, 1080)
        assertEquals(old, qualityChips(old, emptyMap(), oldPhone))
        assertEquals(old, qualityChips(old, emptyMap(), phone4k))
    }

    @Test
    fun aDeviceThatCannotDecodeAnyOfTheTiersStillGetsAChip() {
        assertEquals(listOf(720), qualityChips(listOf(720), mapOf("720" to listOf("vp9")), oldPhone))
        assertEquals(listOf(2160), qualityChips(listOf(2160), mapOf("2160" to listOf("vp9")), oldPhone))
    }

    @Test
    fun autoIsTheTallestChipThatFitsTheScreen() {
        assertEquals(1080, autoTier(all.take(4), 1080))
        assertEquals(1440, autoTier(all, 1440))
        assertEquals(1080, autoTier(all, 1200), "a 1200 px screen does not use 1440")
        assertEquals(2160, autoTier(all, 2160))
        assertEquals(720, autoTier(listOf(360, 720), 1080), "the video's own best")
        assertEquals(360, autoTier(listOf(360, 720), 100))
    }

    @Test
    fun planFollowsTheStoredChoiceAndFallsBack() {
        val r = response(q = 720)
        assertEquals(720, qualityPlan(r, null, phone4k, 1440).quality, "never chosen: the server's default")
        assertEquals(1440, qualityPlan(r, 1440, phone4k, 1080).quality)
        val auto = qualityPlan(r, AUTO_QUALITY, phone4k, 1440)
        assertEquals(1440, auto.quality)
        assertEquals(true, auto.auto)
        assertEquals(1080, qualityPlan(r, AUTO_QUALITY, oldPhone, 2160).quality, "no VP9/AV1 decoder: Auto stops at 1080p")
        // Preferred 2160 on a video that has at most 1080p: the best below it
        val small = response(qualities = listOf(360, 720, 1080), codecs = mapOf("1080" to listOf("avc1")))
        assertEquals(1080, qualityPlan(small, 2160, phone4k, 2160).quality)
        // Preferred 1440 on a device without a 1440p decoder: the best chip below it
        assertEquals(1080, qualityPlan(r, 1440, oldPhone, 1080).quality)
        // Preferred 480 on a video whose lowest is 720: the lowest there is
        assertEquals(720, qualityPlan(response(qualities = listOf(720, 1080), codecs = emptyMap()), 480, phone4k, 1080).quality)
        assertEquals(false, qualityPlan(r, 2160, phone4k, 2160).auto)
    }

    @Test
    fun codecsParamNamesWhatTheDeviceHasInTheServersOrder() {
        assertEquals("avc1,vp9", phone4k.codecsParam)
        assertEquals("avc1", oldPhone.codecsParam)
        assertEquals("avc1", Decoders(emptyMap()).codecsParam)
        assertEquals("avc1,vp9,av1", Decoders(mapOf("av1" to 2160, "vp9" to 2160, "avc1" to 1080)).codecsParam)
    }

    @Test
    fun beforeTheRealTiersAreKnownTheStoredChoiceStillStartsAtItsTier() {
        val unknown = response(q = 720, qualities = listOf(360, 480, 720, 1080), codecs = emptyMap(), known = false)
        val plan = qualityPlan(unknown, 2160, phone4k, 2160)
        assertEquals(2160, plan.quality, "the server falls back to what the video has")
        assertEquals(listOf(360, 480, 720, 1080), plan.chips, "the chips are the usual ones until the real tiers arrive")
        assertEquals(2160, qualityPlan(unknown, AUTO_QUALITY, phone4k, 2160).quality)
        assertEquals(1080, qualityPlan(unknown, 2160, oldPhone, 2160).quality)
        val later = withOffers(plan, listOf(720, 1080), mapOf("1080" to listOf("avc1")), phone4k)
        assertEquals(listOf(720, 1080), later.chips)
        assertEquals(2160, later.quality, "playback is not restarted by the arrival")
        assertEquals(1080, chipFor(later.chips, later.quality), "the chip that stands for it")
    }

    @Test
    fun autoUsesAScreenNoTallerThanTheBestDecoder() {
        assertEquals(1080, qualityPlan(response(), AUTO_QUALITY, oldPhone, 2160).screen)
        assertEquals(1440, qualityPlan(response(), AUTO_QUALITY, vp9To1440, 2160).screen)
        assertEquals(1080, qualityPlan(response(), AUTO_QUALITY, phone4k, 1080).screen)
    }

    @Test
    fun aTierTheDecoderChokedOnStepsDownOne() {
        assertEquals(1440, nextLowerChip(all, 2160))
        assertEquals(1080, nextLowerChip(listOf(360, 720, 1080), 1440), "a tier that is not a chip: the one below it")
        assertEquals(null, nextLowerChip(all, 360))
        assertEquals(null, nextLowerChip(emptyList(), 720))
        for (c in listOf(PlaybackException.ERROR_CODE_DECODER_INIT_FAILED, PlaybackException.ERROR_CODE_DECODING_FAILED, PlaybackException.ERROR_CODE_DECODING_FORMAT_EXCEEDS_CAPABILITIES)) {
            assertEquals(true, isDecoderFailure(c))
        }
        for (c in listOf(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED, PlaybackException.ERROR_CODE_BEHIND_LIVE_WINDOW, PlaybackException.ERROR_CODE_UNSPECIFIED)) {
            assertEquals(false, isDecoderFailure(c))
        }
    }

    @Test
    fun tvPicksAreHeldToWhatTheDeviceDecodes() {
        assertEquals(2160, playableTier(2160, phone4k))
        assertEquals(1080, playableTier(2160, oldPhone))
        assertEquals(1440, playableTier(1440, vp9To1440))
        assertEquals(720, playableTier(720, oldPhone))
    }

    private fun codec(name: String, hw: Boolean, vararg types: Pair<String, Int>) =
        CodecInfoLite(name, types.map { it.first }.toSet(), hw) { mime, tier -> types.any { it.first == mime && tier <= it.second } }

    @Test
    fun decoderSelectionTakesHardwareNonSecureDecodersAtTheirTallestSize() {
        val d = selectDecoders(
            listOf(
                codec("c2.android.vp9.decoder", false, "video/x-vnd.on2.vp9" to 2160), // software: ignored
                codec("c2.qti.vp9.decoder", true, "video/x-vnd.on2.vp9" to 1440),
                codec("c2.qti.vp9.decoder.secure", true, "video/x-vnd.on2.vp9" to 2160), // protected-content path: ignored
                codec("c2.qti.avc.decoder", true, "video/avc" to 1080),
                codec("c2.mtk.av1.decoder", true, "video/av01" to 2160),
            ),
        )
        assertEquals(mapOf("avc1" to 1080, "vp9" to 1440, "av1" to 2160), d.maxHeight)
        assertEquals("avc1,vp9,av1", d.codecsParam)
        // Nothing usable still means H.264 up to 1080p.
        assertEquals(mapOf("avc1" to 1080, "vp9" to 0, "av1" to 0), selectDecoders(emptyList()).maxHeight)
        assertEquals("avc1", selectDecoders(listOf(codec("OMX.google.avc.decoder", false, "video/avc" to 1080))).codecsParam)
        // An AVC decoder that reaches 2160 is believed.
        assertEquals(2160, selectDecoders(listOf(codec("c2.x.avc", true, "video/avc" to 2160))).maxHeight["avc1"])
    }
}
