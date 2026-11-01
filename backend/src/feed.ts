import type { FeedItem } from "./yt/rss.ts";
import type { VideoFacts } from "./yt/api.ts";
import { CHANNEL_ID } from "./store.ts";
import type { FeedPrefs } from "./prefs.ts";

/** The merged feed held in memory per request: newest first, at most this many items. */
export const FEED_CAP = 400;
export const HOME_PAGE = 60;
export const MAX_FEED_PAGE = 100;
const CHUNK = 50; // candidates looked at per round: one Data API call and one SQL query at most

export interface FeedFilter {
  channel?: string;
  hideWatched: boolean;
  shorts: "show" | "hide";
  live: "show" | "hide";
}

export interface FeedDeps {
  /** The merged, sorted, de-duplicated feed (already capped at FEED_CAP). */
  all: FeedItem[];
  facts: (ids: string[]) => Promise<Map<string, VideoFacts>>;
  watched: (ids: string[]) => string[];
}

export interface FeedEntry extends FeedItem {
  /** Present when the feed was filtered on duration or live state and the lookup knew. */
  durationSeconds?: number;
  live?: boolean;
}

export const SHORT_MAX = 60; // seconds: YouTube Shorts are up to 60 s (3 min since late 2024, but 60 s is what the player treats as short)

const time = (i: FeedItem) => Date.parse(i.publishedAt) || 0;

/** Opaque cursor: the position of the last item delivered (time, id). */
export function encodeCursor(i: FeedItem): string {
  return Buffer.from(`${time(i)}:${i.id}`).toString("base64url");
}
const CURSOR = /^(\d{1,15}):([\w-]{11})$/;
export function decodeCursor(c: string): { t: number; id: string } | null {
  if (c.length > 60) return null;
  const m = CURSOR.exec(Buffer.from(c, "base64url").toString("utf8"));
  return m ? { t: Number(m[1]), id: m[2] } : null;
}

/** Merge this with the saved preferences: a query value wins, an absent one falls back to the preference. */
export function parseFilter(q: URLSearchParams, prefs: FeedPrefs): FeedFilter | { error: string } {
  const channel = q.get("channel") ?? "";
  if (channel && !CHANNEL_ID.test(channel)) return { error: "bad channel id" };
  const hw = q.get("hideWatched");
  if (hw !== null && hw !== "0" && hw !== "1") return { error: "bad hideWatched" };
  const pick = (name: "shorts" | "live"): "show" | "hide" | null => {
    const v = q.get(name);
    return v === null ? prefs[name] : v === "show" || v === "hide" ? v : null;
  };
  const shorts = pick("shorts"), live = pick("live");
  if (!shorts) return { error: "bad shorts" };
  if (!live) return { error: "bad live" };
  return { channel: channel || undefined, hideWatched: hw === null ? prefs.hideWatched : hw === "1", shorts, live };
}

/**
 * One page of the feed after `cursor`: walks the sorted feed in chunks, filtering each (duration/live lookups are batched
 * and cached, watched state is one query per chunk), until `limit` items are collected or the feed ends.
 * `next` is set only when at least one more item passes the filters (the walk looks one item ahead).
 */
export async function feedPage(d: FeedDeps, f: FeedFilter, limit: number, cursor: { t: number; id: string } | null): Promise<{ items: FeedEntry[]; next?: string }> {
  let pool = d.all;
  if (f.channel) pool = pool.filter((i) => i.channelId === f.channel);
  let at = 0;
  if (cursor) {
    // Total order is (time desc, id desc): the first item strictly after the cursor.
    at = pool.findIndex((i) => time(i) < cursor.t || (time(i) === cursor.t && i.id < cursor.id));
    if (at < 0) at = pool.length;
  }
  const needFacts = f.shorts === "hide" || f.live === "hide";
  const items: FeedEntry[] = [];
  // One item more than asked for: `next` is only offered when something is really behind this page.
  while (at < pool.length && items.length <= limit) {
    const chunk = pool.slice(at, at + CHUNK);
    let facts = new Map<string, VideoFacts>();
    if (needFacts) {
      // Shorts the feed already marks need no lookup, but the lookup is batched anyway: one call per chunk.
      facts = await d.facts(chunk.map((i) => i.id)).catch((e) => (console.error(`feed: ${(e as Error).message}`), facts)); // unknown facts hide nothing
    }
    const seen = f.hideWatched ? new Set(d.watched(chunk.map((i) => i.id))) : null;
    for (const item of chunk) {
      at++;
      const k = facts.get(item.id);
      const entry: FeedEntry = { ...item };
      if (k && !k.gone) {
        entry.durationSeconds = k.duration || undefined;
        if (k.live) entry.live = true;
      }
      if (seen?.has(item.id)) continue;
      const short = item.short === true || (!!k && !k.gone && !k.live && k.duration > 0 && k.duration <= SHORT_MAX);
      if (f.shorts === "hide" && short) continue;
      if (f.live === "hide" && k?.live) continue;
      items.push(entry);
      if (items.length > limit) break;
    }
  }
  const page = items.slice(0, limit);
  return { items: page, next: items.length > limit ? encodeCursor(page[page.length - 1]) : undefined };
}
