import type { VideoDetail } from "./yt/api.ts";
import type { FeedItem } from "./yt/rss.ts";

/** TV mode needs at least this many subscriptions, so "never the same channel twice" still leaves real variety. */
export const TV_MIN_SUBS = 5;
export const MAX_SEEN = 100; // ids honoured from the `seen` parameter
export const MAX_SEEN_PARAM = MAX_SEEN * 12; // characters of the `seen` parameter that are read
export const MIN_TV_SECONDS = 61; // anything shorter is a Short
export const MAX_CHANNEL_TRIES = 6; // channels examined per pass
export const MAX_VIDEO_TRIES = 5; // candidate videos examined per channel

export interface TvDeps {
  subs: { id: string }[];
  /** Channel of the video that just played; never picked again straight away. */
  after: string;
  seen: ReadonlySet<string>;
  /** Of these ids, the ones already watched to the end. */
  watched: (ids: string[]) => string[];
  feed: (channelId: string) => Promise<FeedItem[]>;
  video: (id: string) => Promise<VideoDetail | null>;
  rand: () => number;
}

const SEEN_ID = /^[\w-]{11}$/;

/** The `seen` query parameter: comma-separated video ids, bounded; malformed entries are dropped. */
export function parseSeen(raw: string): Set<string> {
  return new Set(raw.slice(0, MAX_SEEN_PARAM).split(",").filter((i) => SEEN_ID.test(i)).slice(-MAX_SEEN));
}

/** Fisher-Yates with an injectable random source (rand() in [0, 1)). */
export function shuffled<T>(items: readonly T[], rand: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rand() * (i + 1)));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Playable as an ordinary full-length video: has a duration, is not a Short, and is neither live nor upcoming. */
export function playable(v: VideoDetail | null): v is VideoDetail {
  return !!v && !v.liveBroadcastContent && (v.durationSeconds ?? 0) >= MIN_TV_SECONDS;
}

/**
 * One random video from a random subscribed channel other than `after`. First pass: unseen and unwatched videos.
 * Only when that finds nothing does a second pass allow videos already watched (never ones in `seen`).
 * Failures (a feed that cannot be fetched, a video that cannot be looked up) just move on to the next candidate.
 * Returns null when nothing playable was found within the bounded number of attempts.
 */
export async function pickNext(d: TvDeps): Promise<VideoDetail | null> {
  const channels = d.subs.map((s) => s.id).filter((id) => id !== d.after);
  for (const allowWatched of [false, true]) {
    for (const channelId of shuffled(channels, d.rand).slice(0, MAX_CHANNEL_TRIES)) {
      let items: FeedItem[];
      try {
        items = await d.feed(channelId);
      } catch {
        continue;
      }
      let ids = [...new Set(items.filter((i) => i.channelId === channelId || !i.channelId).map((i) => i.id))].filter((id) => !d.seen.has(id));
      if (!allowWatched && ids.length) {
        const done = new Set(d.watched(ids));
        ids = ids.filter((id) => !done.has(id));
      }
      for (const id of shuffled(ids, d.rand).slice(0, MAX_VIDEO_TRIES)) {
        const v = await d.video(id).catch(() => null);
        if (playable(v) && v.channelId !== d.after) return v;
      }
    }
  }
  return null;
}
