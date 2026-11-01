import { cached } from "./cache.ts";
import { related, type RelatedItem } from "./yt/innertube.ts";
import type { FeedItem } from "./yt/rss.ts";
import type { Subscription } from "./store.ts";

/**
 * "Recommended": ask YouTube what is related to the latest upload of each subscription, then rank
 * by how many of them point at the same video. Free (no Data API quota).
 */
export function recommendations(feed: FeedItem[], subs: Subscription[], limit = 12): Promise<RelatedItem[]> {
  const seeds: FeedItem[] = [];
  for (const f of feed) if (!seeds.some((s) => s.channelId === f.channelId) && seeds.length < 8) seeds.push(f);
  return cached(`recs:${seeds.map((s) => s.id).join(",")}`, 3 * 3600_000, async () => {
    const lists = await Promise.all(seeds.map((s) => related(s.id).catch(() => [] as RelatedItem[])));
    const known = new Set(feed.map((f) => f.id));
    const subNames = new Set(subs.map((s) => s.title.toLowerCase()));
    const score = new Map<string, { item: RelatedItem; n: number; first: number }>();
    lists.flat().forEach((item, pos) => {
      if (known.has(item.id) || subNames.has(item.channelTitle.toLowerCase())) return;
      const e = score.get(item.id);
      if (e) e.n++;
      else score.set(item.id, { item, n: 1, first: pos });
    });
    return [...score.values()].sort((a, b) => b.n - a.n || a.first - b.first).slice(0, limit).map((e) => e.item);
  });
}
