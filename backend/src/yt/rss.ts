import { cached } from "../cache.ts";
import type { Subscription } from "../store.ts";

export interface FeedItem {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  publishedAt: string;
  views?: string;
  description?: string;
}

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&");
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
  })).filter((i) => i.id);
}

export function channelFeed(id: string): Promise<FeedItem[]> {
  return cached(`rss:${id}`, 15 * 60_000, async () => {
    // The endpoint intermittently returns 404/500; a UA plus a couple of retries makes it reliable.
    let status = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${id}`, {
        headers: { "user-agent": "Mozilla/5.0 (X11; Linux x86_64) yt-classic" },
      });
      if (res.ok) return parseFeed(await res.text());
      status = res.status;
    }
    throw new Error(`feed ${id}: ${status}`);
  });
}

/** Merged feed, newest first. A failing channel is skipped rather than breaking the page. */
export async function subscriptionFeed(subs: Subscription[], limit = 60): Promise<FeedItem[]> {
  const all = await Promise.all(subs.map((s) => channelFeed(s.id).catch((e) => (console.error(e.message), []))));
  return all.flat().sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)).slice(0, limit);
}
