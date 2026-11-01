package io.github.dodwmd.ytclassic.data

import kotlinx.serialization.SerialName
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
    /** Unfinished videos to pick up again, most recent first. */
    @SerialName("continue") val resume: List<HistoryItem> = emptyList(),
)

/** Where the server last saw this video: [position] in seconds. */
@Serializable
data class Progress(val position: Long = 0, val completed: Boolean = false)

/** One watched video; title and channel come from the server's own metadata. */
@Serializable
data class HistoryItem(
    val id: String,
    val title: String,
    val channelId: String = "",
    val channelTitle: String = "",
    val thumb: String = "",
    val durationSeconds: Long = 0,
    val position: Long = 0,
    val completed: Boolean = false,
    val lastWatched: Long = 0,
    val watchCount: Int = 0,
) {
    /** 0..1, or null when the length is unknown or the video is finished. */
    val fraction: Float? get() = if (completed || durationSeconds <= 0) null else (position.toFloat() / durationSeconds).coerceIn(0f, 1f)
}

@Serializable
data class HistoryPage(val items: List<HistoryItem> = emptyList(), val next: String? = null)

@Serializable
data class WatchedResponse(val ids: List<String> = emptyList())

/** A user-curated playlist. Id 1 is the built-in "Watch later" ([builtin]): it cannot be renamed or deleted. */
@Serializable
data class Playlist(val id: Long, val name: String, val count: Int = 0, val builtin: Boolean = false)

@Serializable
data class PlaylistsResponse(val playlists: List<Playlist> = emptyList())

/** Reply to create / rename / add: the playlist as it is now ([added] is false when the video was already there). */
@Serializable
data class PlaylistReply(val playlist: Playlist? = null, val added: Boolean = false)

/** One saved video; the title and channel are the server's own copy, so a list needs no API calls. */
@Serializable
data class PlaylistItem(
    val id: String,
    val title: String,
    val channelId: String = "",
    val channelTitle: String = "",
    val thumb: String = "",
    val durationSeconds: Long = 0,
    val added: Long = 0,
)

@Serializable
data class PlaylistPage(val playlist: Playlist, val items: List<PlaylistItem> = emptyList(), val next: String? = null)

/** `watchLater`: the asked ids that are in Watch later; `any`: those in at least one playlist. */
@Serializable
data class MembershipResponse(val watchLater: List<String> = emptyList(), val any: List<String> = emptyList())

@Serializable
data class OkReply(val removed: Boolean = false, val moved: Boolean = false)

@Serializable
data class VideoResponse(
    val video: VideoDetail,
    val related: RelatedList = RelatedList(),
    val quality: Int = 720,
    val qualities: List<Int> = listOf(360, 480, 720, 1080),
    val lang: String = "",
    val progress: Progress? = null,
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

/** Result of POST /api/subscriptions/import; [total] is the subscription count after the import. */
@Serializable
data class ImportResult(val added: Int = 0, val existing: Int = 0, val skipped: ImportSkipped = ImportSkipped(), val total: Int = 0)

@Serializable
data class ImportSkipped(val invalid: Int = 0, val handles: Int = 0, val full: Int = 0)

/** An error body. [code], [have] and [need] are only set by the few errors a client acts on (TV's "need-subscriptions"). */
@Serializable
data class ApiError(val error: String = "", val code: String = "", val have: Int = 0, val need: Int = 0)

/** `GET /api/tv/next`: the next TV video, shaped like the watch page's data (no related list) plus its channel. */
@Serializable
data class TvResponse(val video: VideoDetail, val channelId: String = "", val quality: Int = 720)

/** `GET /api/session`: whether the server wants an access token and whether this client's is accepted. */
@Serializable
data class SessionResponse(val auth: String, val authenticated: Boolean)

/** GET /api/status: the backend's own health (yt-dlp version, last resolve outcomes, ffmpeg, storage). */
@Serializable
data class StatusResponse(
    val health: String = "",
    val ytdlp: ToolStatus = ToolStatus(),
    val resolves: ResolveStats = ResolveStats(),
    val ffmpeg: ToolStatus = ToolStatus(),
    val node: String = "",
    val uptimeSeconds: Long = 0,
    val cache: CacheStatus = CacheStatus(),
)

@Serializable
data class ToolStatus(val present: Boolean = false, val version: String? = null)

@Serializable
data class ResolveStats(
    val ok: Int = 0,
    val failed: Int = 0,
    val consecutiveFailures: Int = 0,
    val lastSuccess: ResolveSuccess? = null,
    val lastFailure: ResolveFailure? = null,
)

@Serializable
data class ResolveSuccess(val at: String = "")

@Serializable
data class ResolveFailure(val at: String = "", val reason: String = "")

@Serializable
data class CacheStatus(val ok: Boolean = false, val entries: Int = 0, val bytes: Long = 0)
