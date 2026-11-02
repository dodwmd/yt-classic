package io.github.dodwmd.ytclassic

import io.github.dodwmd.ytclassic.data.VideoDetail
import io.github.dodwmd.ytclassic.data.VideoResponse
import io.github.dodwmd.ytclassic.player.AUTO_QUALITY
import io.github.dodwmd.ytclassic.player.Decoders
import io.github.dodwmd.ytclassic.player.autoTier
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

    private fun response(q: Int = 720, qualities: List<Int> = all, codecs: Map<String, List<String>> = this.codecs) =
        Json.decodeFromString<VideoResponse>("""{"video":{"id":"abc","title":"t"},"quality":$q,"qualities":${qualities},"codecs":${Json.encodeToString(codecs)}}""")

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
}
