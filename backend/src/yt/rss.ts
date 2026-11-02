import { cached } from "../cache.ts";
import { fetchT } from "../http.ts";
import { limiter } from "../limit.ts";
import { channelVideos } from "./api.ts";
import type { Subscription } from "../store.ts";

export interface FeedItem {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  views?: string;
  description?: string;
  /** The feed linked it as /shorts/<id>. Absent otherwise (RSS does not always say). */
  short?: boolean;
}

// Out-of-range or surrogate references (which String.fromCodePoint rejects or mangles) become U+FFFD instead of throwing.
const codePoint = (n: number) => (n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : "�");
const decode = (s: string) =>
  s.replace(/&#x([0-9a-f]+);/gi, (_, h) => codePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => codePoint(Number(d)))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
const tag = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
  return m ? decode(m[1]) : "";
};

export function parseFeed(xml: string): FeedItem[] {
  const channelId = tag(xml.split("<entry>")[0], "yt:channelId");
  return xml.split("<entry>").slice(1).map((e) => ({
    id: tag(e, "yt:videoId"),
    title: tag(e, "title"),
    channelId: tag(e, "yt:channelId") || channelId,
    channelTitle: tag(e.slice(e.indexOf("<author>")), "name"),
    publishedAt: tag(e, "published"),
    views: /<media:statistics views="(\d+)"/.exec(e)?.[1],
    description: tag(e, "media:description").slice(0, 300) || undefined,
    short: /<link[^>]*href="[^"]*\/shorts\//.test(e) || undefined,
  })).filter((i) => i.id);
}

// A cold home page would otherwise open one request per subscription (up to 500) at the same moment.
const rssSlots = limiter(8, Infinity);

async function fetchRss(id: string): Promise<FeedItem[]> {
  let status = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300 * attempt));
    const res = await fetchT(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, {
      headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) yt-classic" },
    });
    if (res.ok) return parseFeed(await res.text());
    status = res.status;
  }
  throw new Error(`feed ${id}: ${status}`);
}

/** The channel's recent uploads from the Data API (1 quota unit): same shape as the RSS items, minus view counts. */
async function uploadsAsFeed(id: string): Promise<FeedItem[]> {
  const page = await channelVideos(id);
  return page.items.map((v) => ({
    id: v.id, title: v.title, channelId: id, channelTitle: v.channelTitle, publishedAt: v.publishedAt, description: v.description.slice(0, 300) || undefined,
  }));
}

export function channelFeed(id: string): Promise<FeedItem[]> {
  return cached(`rss:${id}`, 15 * 60_000, async () => {
    try {
      return await rssSlots.run(() => fetchRss(id));
    } catch (e) {
      // YouTube's feed endpoint intermittently answers 404/500 for minutes at a time. Don't blank the home page.
      console.error(`${(e as Error).message}; falling back to the Data API`);
      return uploadsAsFeed(id);
    }
  }, true);
}

/** Merged feed, newest first. A failing channel is skipped rather than breaking the page. */
export async function subscriptionFeed(subs: Subscription[], limit = 60): Promise<FeedItem[]> {
  const all = await Promise.all(subs.map((s) => channelFeed(s.id).catch((e) => (console.error(e.message), []))));
  return mergeFeeds(all, limit);
}

/** Newest first; equal timestamps order by id, descending, so the order is total and cursors never skip or repeat. A video listed twice is kept once. */
export function mergeFeeds(feeds: FeedItem[][], limit: number): FeedItem[] {
  const seen = new Set<string>();
  const all = feeds.flat().filter((i) => !seen.has(i.id) && seen.add(i.id));
  return all.sort((a, b) => (Date.parse(b.publishedAt) || 0) - (Date.parse(a.publishedAt) || 0) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)).slice(0, limit);
}
