import { cached } from "../cache.ts";
import { isoSeconds } from "../format.ts";
import { fetchT } from "../http.ts";

export interface VideoSummary {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  description: string;
  publishedAt: string;
  thumb: string;
  durationSeconds?: number;
  views?: string;
}
export interface SearchPage {
  items: VideoSummary[];
  nextPageToken?: string;
  prevPageToken?: string;
}

const BASE = "https://www.googleapis.com/youtube/v3";

async function call(path: string, params: Record<string, string>): Promise<any> {
  const key = process.env.YT_API_KEY;
  if (!key) throw new Error("YT_API_KEY is not set");
  const url = `${BASE}/${path}?${new URLSearchParams({ ...params, key })}`;
  const res = await fetchT(url);
  if (!res.ok) {
    // Never include the URL (contains the key) in errors.
    const body = await res.json().catch(() => ({}));
    throw new Error(`YouTube API ${path} failed: ${res.status} ${body?.error?.message ?? ""}`);
  }
  return res.json();
}

const TEN_MIN = 10 * 60_000;

/** Data API search: 100 quota units. Used only as a fallback for yt-dlp search. */
export function apiSearch(q: string, pageToken = ""): Promise<SearchPage> {
  return cached(`search:${q}:${pageToken}`, TEN_MIN, async () => {
    const params: Record<string, string> = { part: "snippet", type: "video", maxResults: "20", q };
    if (pageToken) params.pageToken = pageToken;
    const data = await call("search", params); // 100 quota units
    const items: VideoSummary[] = (data.items ?? []).map((i: any) => ({
      id: i.id.videoId,
      title: i.snippet.title,
      channelId: i.snippet.channelId,
      channelTitle: i.snippet.channelTitle,
      description: i.snippet.description,
      publishedAt: i.snippet.publishedAt,
      thumb: i.snippet.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${i.id.videoId}/mqdefault.jpg`,
    }));
    const details = await videoDetails(items.map((i) => i.id));
    for (const it of items) {
      const iso = details.get(it.id)?.duration;
      it.durationSeconds = iso ? isoSeconds(iso) : undefined;
      it.views = details.get(it.id)?.views;
    }
    return { items, nextPageToken: data.nextPageToken, prevPageToken: data.prevPageToken };
  });
}

async function videoDetails(ids: string[]): Promise<Map<string, { duration: string; views?: string }>> {
  const out = new Map<string, { duration: string; views?: string }>();
  if (!ids.length) return out;
  const data = await call("videos", { part: "contentDetails,statistics", id: ids.join(",") }); // 1 unit
  for (const v of data.items ?? []) out.set(v.id, { duration: v.contentDetails.duration, views: v.statistics?.viewCount });
  return out;
}

export interface VideoDetail extends VideoSummary {
  likes?: string;
  /** "live" or "upcoming" for streams; absent for ordinary videos (and for entries cached before this field existed). */
  liveBroadcastContent?: string;
}

export function video(id: string): Promise<VideoDetail | null> {
  return cached(`video:${id}`, TEN_MIN, async () => {
    const data = await call("videos", { part: "snippet,contentDetails,statistics", id }); // 1 unit
    const v = data.items?.[0];
    if (!v) return null;
    return {
      id: v.id,
      title: v.snippet.title,
      channelId: v.snippet.channelId,
      channelTitle: v.snippet.channelTitle,
      description: v.snippet.description,
      publishedAt: v.snippet.publishedAt,
      thumb: v.snippet.thumbnails?.medium?.url ?? "",
      durationSeconds: isoSeconds(v.contentDetails.duration),
      views: v.statistics?.viewCount,
      likes: v.statistics?.likeCount,
      liveBroadcastContent: v.snippet.liveBroadcastContent === "live" || v.snippet.liveBroadcastContent === "upcoming" ? v.snippet.liveBroadcastContent : undefined,
    };
  }, true);
}

/** Related is not available in the API any more; use the channel's recent uploads (1 unit). */
export function channelUploads(channelId: string, excludeId = ""): Promise<VideoSummary[]> {
  return cached(`uploads:${channelId}`, TEN_MIN, async () => {
    const data = await call("playlistItems", {
      part: "snippet",
      playlistId: "UU" + channelId.slice(2),
      maxResults: "15",
    });
    return (data.items ?? []).map((i: any) => ({
      id: i.snippet.resourceId.videoId,
      title: i.snippet.title,
      channelId: i.snippet.channelId ?? channelId,
      channelTitle: i.snippet.videoOwnerChannelTitle ?? "",
      description: i.snippet.description,
      publishedAt: i.snippet.publishedAt,
      thumb: i.snippet.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${i.snippet.resourceId.videoId}/mqdefault.jpg`,
    })).filter((v: VideoSummary) => v.id !== excludeId);
  });
}

export interface Channel {
  id: string;
  title: string;
  description: string;
  thumb: string;
  banner?: string;
  subscribers?: string;
  videoCount?: string;
}

export function channel(id: string): Promise<Channel | null> {
  return cached(`channel:${id}`, 60 * 60_000, async () => {
    const data = await call("channels", { part: "snippet,statistics,brandingSettings", id }); // 1 unit
    const c = data.items?.[0];
    if (!c) return null;
    return {
      id: c.id,
      title: c.snippet.title,
      description: c.snippet.description,
      thumb: c.snippet.thumbnails?.default?.url ?? "",
      banner: c.brandingSettings?.image?.bannerExternalUrl,
      subscribers: c.statistics?.hiddenSubscriberCount ? undefined : c.statistics?.subscriberCount,
      videoCount: c.statistics?.videoCount,
    };
  }, true);
}

export async function channelVideos(channelId: string, pageToken = ""): Promise<SearchPage> {
  return cached(`chvideos:${channelId}:${pageToken}`, TEN_MIN, async () => {
    const params: Record<string, string> = { part: "snippet", playlistId: "UU" + channelId.slice(2), maxResults: "24" };
    if (pageToken) params.pageToken = pageToken;
    const data = await call("playlistItems", params); // 1 unit
    const items: VideoSummary[] = (data.items ?? []).map((i: any) => ({
      id: i.snippet.resourceId.videoId,
      title: i.snippet.title,
      channelId,
      channelTitle: i.snippet.videoOwnerChannelTitle ?? "",
      description: i.snippet.description,
      publishedAt: i.snippet.publishedAt,
      thumb: i.snippet.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${i.snippet.resourceId.videoId}/mqdefault.jpg`,
    }));
    return { items, nextPageToken: data.nextPageToken, prevPageToken: data.prevPageToken };
  }, true);
}

// --- Channel tabs ---------------------------------------------------------------------------------------------

/** A public playlist id as the Data API hands them out (PL..., OL..., UU..., FL...): strict, so nothing odd reaches the API. */
export const YT_PLAYLIST_ID = /^[A-Za-z]{2}[\w-]{8,62}$/;

export interface PlaylistSummary {
  id: string;
  title: string;
  description: string;
  thumb: string;
  itemCount?: number;
  publishedAt: string;
}
export interface PlaylistPage {
  items: PlaylistSummary[];
  nextPageToken?: string;
}
export interface TabVideo extends VideoSummary {
  /** "live" or "upcoming" for current/scheduled streams, "ended" for finished ones; absent for ordinary uploads. */
  live?: "live" | "upcoming" | "ended";
}
export interface TabPage {
  items: TabVideo[];
  nextPageToken?: string;
}
export interface ChannelAbout {
  id: string;
  title: string;
  description: string;
  customUrl?: string;
  publishedAt?: string;
  country?: string;
  viewCount?: string;
  subscriberCount?: string;
  videoCount?: string;
  links: string[];
}

const HOUR = 60 * 60_000;
const SHORT_MAX_SECONDS = 61;
/** Shorts/Live scan at most this many uploads pages (50 videos each) per request: 2 quota units a page. */
export const MAX_SCAN_PAGES = 3;
const WANT_ITEMS = 12;

/** A playlistItems page of a playlist that does not exist (a channel with no uploads yet) is simply empty. */
async function playlistItemsPage(playlistId: string, pageToken: string, maxResults: number): Promise<any> {
  const params: Record<string, string> = { part: "snippet", playlistId, maxResults: String(maxResults) };
  if (pageToken) params.pageToken = pageToken;
  try {
    return await call("playlistItems", params); // 1 unit
  } catch (e) {
    if (/failed: 404/.test((e as Error).message)) return { items: [] };
    throw e;
  }
}

const thumbOf = (s: any, id: string) => s?.thumbnails?.medium?.url ?? s?.thumbnails?.default?.url ?? `https://i.ytimg.com/vi/${id}/mqdefault.jpg`;
const hidden = (s: any) => s?.title === "Private video" || s?.title === "Deleted video";

export function channelPlaylists(channelId: string, pageToken = ""): Promise<PlaylistPage> {
  return cached(`chplaylists:${channelId}:${pageToken}`, 30 * 60_000, async () => {
    const params: Record<string, string> = { part: "snippet,contentDetails", channelId, maxResults: "24" };
    if (pageToken) params.pageToken = pageToken;
    const data = await call("playlists", params); // 1 unit
    const items: PlaylistSummary[] = (data.items ?? []).map((p: any) => ({
      id: p.id,
      title: p.snippet?.title ?? "",
      description: p.snippet?.description ?? "",
      thumb: p.snippet?.thumbnails?.medium?.url ?? p.snippet?.thumbnails?.default?.url ?? "",
      itemCount: typeof p.contentDetails?.itemCount === "number" ? p.contentDetails.itemCount : undefined,
      publishedAt: p.snippet?.publishedAt ?? "",
    }));
    return { items, nextPageToken: data.nextPageToken };
  }, true);
}

/** The playlist's title if it belongs to this channel, else null (so the route can't be used to browse other people's playlists). */
export function ownedPlaylist(channelId: string, playlistId: string): Promise<{ id: string; title: string } | null> {
  return cached(`chplaylist:${playlistId}`, HOUR, async () => {
    const data = await call("playlists", { part: "snippet", id: playlistId }); // 1 unit
    const p = data.items?.[0];
    return p ? { id: p.id, title: p.snippet?.title ?? "", channelId: p.snippet?.channelId ?? "" } : null;
  }, true).then((p: any) => (p && p.channelId === channelId ? { id: p.id, title: p.title } : null));
}

export function playlistVideos(channelId: string, playlistId: string, pageToken = ""): Promise<SearchPage> {
  return cached(`plitems:${playlistId}:${pageToken}`, TEN_MIN, async () => {
    const data = await playlistItemsPage(playlistId, pageToken, 24);
    const items: VideoSummary[] = (data.items ?? [])
      .filter((i: any) => i.snippet?.resourceId?.videoId && !hidden(i.snippet))
      .map((i: any) => ({
        id: i.snippet.resourceId.videoId,
        title: i.snippet.title,
        channelId: i.snippet.videoOwnerChannelId ?? channelId,
        channelTitle: i.snippet.videoOwnerChannelTitle ?? "",
        description: i.snippet.description ?? "",
        publishedAt: i.snippet.publishedAt,
        thumb: thumbOf(i.snippet, i.snippet.resourceId.videoId),
      }));
    return { items, nextPageToken: data.nextPageToken };
  }, true);
}

/** One uploads page (50 videos) with durations and live state: 2 quota units, shared by the Shorts and Live tabs. */
function scannedUploads(channelId: string, pageToken: string): Promise<TabPage> {
  return cached(`chscan:${channelId}:${pageToken}`, TEN_MIN, async () => {
    const data = await playlistItemsPage("UU" + channelId.slice(2), pageToken, 50);
    const base = (data.items ?? []).filter((i: any) => i.snippet?.resourceId?.videoId && !hidden(i.snippet));
    const ids: string[] = base.map((i: any) => i.snippet.resourceId.videoId);
    const details = new Map<string, any>();
    if (ids.length) {
      const d = await call("videos", { part: "contentDetails,liveStreamingDetails,snippet", id: ids.join(",") }); // 1 unit for up to 50 ids
      for (const v of d.items ?? []) details.set(v.id, v);
    }
    const items: TabVideo[] = [];
    for (const i of base) {
      const id: string = i.snippet.resourceId.videoId;
      const v = details.get(id);
      if (!v) continue; // not visible any more
      const state = v.snippet?.liveBroadcastContent;
      const live = state === "live" || state === "upcoming" ? state : v.liveStreamingDetails ? "ended" : undefined;
      items.push({
        id,
        title: i.snippet.title,
        channelId,
        channelTitle: i.snippet.videoOwnerChannelTitle ?? "",
        description: i.snippet.description ?? "",
        publishedAt: i.snippet.publishedAt,
        thumb: thumbOf(i.snippet, id),
        durationSeconds: isoSeconds(v.contentDetails?.duration),
        live,
      });
    }
    return { items, nextPageToken: data.nextPageToken };
  });
}

/** Shorts or Live from the uploads: scans up to MAX_SCAN_PAGES pages until it has enough, then hands back the token to continue from. */
export async function channelKind(channelId: string, kind: "shorts" | "live", pageToken = ""): Promise<TabPage> {
  const match = (v: TabVideo) => (kind === "shorts" ? !v.live && v.durationSeconds! > 0 && v.durationSeconds! <= SHORT_MAX_SECONDS : v.live !== undefined);
  const items: TabVideo[] = [];
  let token = pageToken;
  let next: string | undefined;
  for (let n = 0; n < MAX_SCAN_PAGES; n++) {
    const page = await scannedUploads(channelId, token);
    items.push(...page.items.filter(match));
    next = page.nextPageToken;
    if (!next || items.length >= WANT_ITEMS) break;
    token = next;
  }
  return { items, nextPageToken: next };
}

/** Links are the http(s) URLs in the description: the Data API has no channel links field. */
export function descriptionLinks(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s<>"')\]]+/gi)) {
    const u = m[0].replace(/[.,;:!?]+$/, "");
    try {
      const p = new URL(u);
      if ((p.protocol === "http:" || p.protocol === "https:") && !out.includes(p.href) && u.length <= 300) out.push(p.href);
    } catch { /* not a URL */ }
    if (out.length >= 20) break;
  }
  return out;
}

export function channelAbout(id: string): Promise<ChannelAbout | null> {
  return cached(`chabout:${id}`, HOUR, async () => {
    const data = await call("channels", { part: "snippet,statistics,brandingSettings", id }); // 1 unit
    const c = data.items?.[0];
    if (!c) return null;
    const description = String(c.snippet?.description ?? "");
    return {
      id: c.id,
      title: c.snippet?.title ?? "",
      description,
      customUrl: c.snippet?.customUrl,
      publishedAt: c.snippet?.publishedAt,
      country: c.snippet?.country ?? c.brandingSettings?.channel?.country,
      viewCount: c.statistics?.viewCount,
      subscriberCount: c.statistics?.hiddenSubscriberCount ? undefined : c.statistics?.subscriberCount,
      videoCount: c.statistics?.videoCount,
      links: descriptionLinks(description),
    };
  }, true);
}
