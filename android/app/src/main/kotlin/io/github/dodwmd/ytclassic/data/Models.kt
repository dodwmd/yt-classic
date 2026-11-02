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
    /** Only present when the server looked it up (a Shorts or live filter is on). */
    val durationSeconds: Long? = null,
    val live: Boolean = false,
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
    /** On the channel's Shorts/Live tabs: "live", "upcoming" or "ended" for streams. */
    val live: String? = null,
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
    /** The video's comment count as the Data API reports it; null when comments are off (or an older server). */
    val commentCount: String? = null,
)

@Serializable
data class SearchPage(
    val items: List<VideoSummary> = emptyList(),
    val nextPageToken: String? = null,
    val prevPageToken: String? = null,
    /** Plain-language remarks from the server, e.g. a filter that could only be approximated. */
    val notes: List<String> = emptyList(),
)

/** One channel in a channel search. [subscribed] is computed by the server per request. */
@Serializable
data class ChannelHit(
    val id: String,
    val title: String = "",
    val thumb: String = "",
    val description: String = "",
    val subscribers: String? = null,
    val handle: String? = null,
    val subscribed: Boolean = false,
)

@Serializable
data class ChannelSearchPage(
    val channels: List<ChannelHit> = emptyList(),
    val nextPageToken: String? = null,
    val notes: List<String> = emptyList(),
)

@Serializable
data class RecentSearch(val id: Long, val query: String, val at: Long = 0)

@Serializable
data class RecentSearches(val searches: List<RecentSearch> = emptyList())

@Serializable
data class Suggestions(val suggestions: List<String> = emptyList())

@Serializable
data class RelatedList(val heading: String = "", val items: List<RelatedItem> = emptyList())

@Serializable
data class HomeResponse(
    val subs: List<Sub> = emptyList(),
    val feed: List<FeedItem> = emptyList(),
    /** Cursor for the rest of the feed (GET api/feed?before=...); null when this is all of it. */
    val next: String? = null,
    /** The filters saved on the server, already applied to [feed]. */
    val prefs: FeedPrefs = FeedPrefs(),
    /** Unfinished videos to pick up again, most recent first. */
    @SerialName("continue") val resume: List<HistoryItem> = emptyList(),
)

/** Home feed filters shared by the web and Android clients (GET/POST api/prefs). */
@Serializable
data class FeedPrefs(val hideWatched: Boolean = false, val shorts: String = "show", val live: String = "show")

@Serializable
data class FeedPage(val items: List<FeedItem> = emptyList(), val next: String? = null)

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

/** `GET /api/video/:id/qualities`: the tiers this video really has, with the codec families per tier. */
@Serializable
data class QualitiesResponse(
    val qualities: List<Int> = emptyList(),
    val codecs: Map<String, List<String>> = emptyMap(),
    val tiersKnown: Boolean = false,
)

@Serializable
data class VideoResponse(
    val video: VideoDetail,
    val related: RelatedList = RelatedList(),
    val quality: Int = 720,
    /** True when the request was `q=auto`: [quality] is then what Auto chose for the sent screen height and codecs. */
    val auto: Boolean = false,
    val qualities: List<Int> = listOf(360, 480, 720, 1080),
    /** Per tier (as a string key), the codec families the video has there: "avc1", "vp9", "av1". Empty when unknown. */
    val codecs: Map<String, List<String>> = emptyMap(),
    /** False when [qualities] is only the usual list because the server has not looked at this video's formats yet. */
    val tiersKnown: Boolean = true,
    val lang: String = "",
    val progress: Progress? = null,
    /** False only when the server already knows the video can't be played; [reason] is the error code, [message] the explanation. */
    val playable: Boolean = true,
    val reason: String? = null,
    val message: String = "",
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

/** One of a channel's public playlists (the Playlists tab). */
@Serializable
data class ChannelPlaylist(
    val id: String,
    val title: String = "",
    val description: String = "",
    val thumb: String = "",
    val itemCount: Int? = null,
    val publishedAt: String = "",
)

@Serializable
data class ChannelPlaylists(val items: List<ChannelPlaylist> = emptyList(), val nextPageToken: String? = null)

@Serializable
data class ChannelPlaylistsResponse(val page: ChannelPlaylists = ChannelPlaylists())

/** Shorts and Live tabs. */
@Serializable
data class ChannelTabResponse(val page: SearchPage = SearchPage())

@Serializable
data class PlaylistRef(val id: String, val title: String = "")

/** The videos of one of the channel's playlists. */
@Serializable
data class ChannelPlaylistResponse(val playlist: PlaylistRef, val page: SearchPage = SearchPage())

@Serializable
data class ChannelAbout(
    val id: String,
    val title: String = "",
    val description: String = "",
    val customUrl: String? = null,
    val publishedAt: String? = null,
    val country: String? = null,
    val viewCount: String? = null,
    val subscriberCount: String? = null,
    val videoCount: String? = null,
    val links: List<String> = emptyList(),
)

/** One comment or reply from the backend: plain text only (the server strips markup), [replyCount] is 0 for replies. */
@Serializable
data class Comment(
    val id: String,
    val author: String = "",
    val authorChannelId: String? = null,
    val authorThumb: String? = null,
    val text: String = "",
    val likeCount: Long = 0,
    val publishedAt: String = "",
    val updatedAt: String? = null,
    val replyCount: Int = 0,
)

@Serializable
data class CommentPage(val items: List<Comment> = emptyList(), val nextPageToken: String? = null)

@Serializable
data class ChannelAboutResponse(val about: ChannelAbout)

@Serializable
data class SubscribeResponse(val subscribed: Boolean)

/** Result of POST /api/subscriptions/import; [total] is the subscription count after the import. */
@Serializable
data class ImportResult(val added: Int = 0, val existing: Int = 0, val skipped: ImportSkipped = ImportSkipped(), val total: Int = 0)

@Serializable
data class ImportSkipped(val invalid: Int = 0, val handles: Int = 0, val full: Int = 0)

/** An error body. [code], [have] and [need] are only set by the few errors a client acts on (TV's "need-subscriptions"). */
@Serializable
data class ApiError(val error: String = "", val code: String = "", val retryable: Boolean = false, val have: Int = 0, val need: Int = 0)

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
    val streams: StreamStats = StreamStats(),
    val dataApi: DataApiStatus = DataApiStatus(),
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
data class CacheStatus(val ok: Boolean = false, val entries: Int = 0, val bytes: Long = 0, val hits: Long = 0, val misses: Long = 0, val dbBytes: Long? = null)

@Serializable
data class StreamStats(val active: Int = 0, val started: Int = 0, val finished: Int = 0, val failed: Int = 0)

@Serializable
data class DataApiStatus(val unitsToday: Int = 0, val searchFallbackRemaining: Int = 0)
