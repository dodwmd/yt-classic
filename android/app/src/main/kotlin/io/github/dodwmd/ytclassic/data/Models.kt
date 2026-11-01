package io.github.dodwmd.ytclassic.data

import kotlinx.serialization.Serializable

// These mirror the backend's JSON (see backend/src/app.ts). Optional fields are nullable or defaulted because
// the backend omits them when YouTube doesn't provide them (e.g. no view count on feed items).

@Serializable
data class Sub(val id: String, val title: String)

@Serializable
data class FeedItem(
    val id: String,
    val title: String,
    val channelId: String,
    val channelTitle: String,
    val publishedAt: String = "",
    val views: String? = null,
    val description: String? = null,
)

/** Items from YouTube's watch-next feed: display strings ("1.2M", "2mo ago"), no channel id. */
@Serializable
data class RelatedItem(
    val id: String,
    val title: String,
    val channelTitle: String = "",
    val views: String? = null,
    val age: String? = null,
    val duration: String? = null,
    val publishedAt: String? = null,
    val thumb: String = "",
)

@Serializable
data class VideoSummary(
    val id: String,
    val title: String,
    val channelId: String = "",
    val channelTitle: String = "",
    val description: String = "",
    val publishedAt: String = "",
    val thumb: String = "",
    val durationSeconds: Long? = null,
    val views: String? = null,
)

@Serializable
data class VideoDetail(
    val id: String,
    val title: String,
    val channelId: String = "",
    val channelTitle: String = "",
    val description: String = "",
    val publishedAt: String = "",
    val thumb: String = "",
    val durationSeconds: Long? = null,
    val views: String? = null,
    val likes: String? = null,
)

@Serializable
data class SearchPage(
    val items: List<VideoSummary> = emptyList(),
    val nextPageToken: String? = null,
    val prevPageToken: String? = null,
)

@Serializable
data class RelatedList(val heading: String = "", val items: List<RelatedItem> = emptyList())

@Serializable
data class HomeResponse(
    val subs: List<Sub> = emptyList(),
    val feed: List<FeedItem> = emptyList(),
)

@Serializable
data class VideoResponse(
    val video: VideoDetail,
    val related: RelatedList = RelatedList(),
    val quality: Int = 720,
    val qualities: List<Int> = listOf(360, 480, 720, 1080),
    val lang: String = "",
)

@Serializable
data class Channel(
    val id: String,
    val title: String,
    val description: String = "",
    val thumb: String = "",
    val banner: String? = null,
    val subscribers: String? = null,
    val videoCount: String? = null,
)

@Serializable
data class ChannelResponse(val channel: Channel, val page: SearchPage = SearchPage(), val subscribed: Boolean = false)

@Serializable
data class SubscribeResponse(val subscribed: Boolean)

@Serializable
data class ApiError(val error: String = "")
