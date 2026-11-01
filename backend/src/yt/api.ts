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
    };
  });
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
  });
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
  });
}
