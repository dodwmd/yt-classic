import type { VideoDetail } from "./yt/api.ts";
import type { FeedItem } from "./yt/rss.ts";

/** TV mode needs at least this many subscriptions, so "never the same channel twice" still leaves real variety. */
export const TV_MIN_SUBS = 5;
export const MAX_SEEN = 100; // ids honoured from the `seen` parameter
export const MAX_SEEN_PARAM = MAX_SEEN * 12; // characters of the `seen` parameter that are read
export const MIN_TV_SECONDS = 61; // anything shorter is a Short
// One request examines at most this many channel feeds and looks up this many videos (one cached Data API unit each),
// within this long. A pick walks the channels in random order, so it only gives up once the budget is spent or every
// channel has been examined.
export const MAX_FEEDS = 40;
export const MAX_LOOKUPS = 40;
export const MAX_VIDEOS_PER_CHANNEL = 5; // candidate videos looked up per channel
export const TIME_BUDGET_MS = 12_000;
export const CONCURRENCY = 4; // channels examined at the same time

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
  /** Aborted when the client went away: the pick stops looking things up. */
  signal?: AbortSignal;
  now?: () => number;
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
 * One random video from a random subscribed channel other than `after`. Channels are walked in random order (a few at a
 * time) until one yields an unseen, unwatched, playable video. Videos already watched are only considered once every
 * channel has been examined and none had anything unwatched; a video in `seen` is never returned. Failures (a feed that
 * cannot be fetched, a video that cannot be looked up) just move on. Returns null when nothing playable was found within
 * the budget (feeds, lookups, time, or the client leaving).
 */
export async function pickNext(d: TvDeps): Promise<VideoDetail | null> {
  const now = d.now ?? Date.now;
  const deadline = now() + TIME_BUDGET_MS;
  const stop = () => !!d.signal?.aborted || now() > deadline;
  const channels = shuffled(d.subs.map((s) => s.id).filter((id) => id !== d.after), d.rand);
  const batch = Math.max(1, CONCURRENCY);
  let lookups = 0;
  let feeds = 0;
  const candidates = new Map<string, string[]>(); // channel -> unseen ids, shuffled; absent: feed failed

  const lookup = async (id: string): Promise<VideoDetail | null> => {
    if (stop() || lookups >= MAX_LOOKUPS) return null;
    lookups++;
    const v = await d.video(id).catch(() => null);
    return playable(v) && v.channelId !== d.after ? v : null;
  };
  const tryChannel = async (ids: string[]): Promise<VideoDetail | null> => {
    for (const id of ids.slice(0, MAX_VIDEOS_PER_CHANNEL)) {
      const v = await lookup(id);
      if (v) return v;
      if (stop()) return null;
    }
    return null;
  };

  // Pass 1: unwatched videos, channel by channel.
  let examinedAll = true;
  for (let i = 0; i < channels.length; i += batch) {
    const slice = channels.slice(i, i + batch).slice(0, Math.max(0, MAX_FEEDS - feeds));
    if (slice.length < Math.min(batch, channels.length - i) || stop()) {
      examinedAll = false;
      break;
    }
    feeds += slice.length;
    const found = await Promise.all(slice.map(async (channelId) => {
      let items: FeedItem[];
      try {
        items = await d.feed(channelId);
      } catch {
        return null;
      }
      const ids = [...new Set(items.filter((it) => !it.channelId || it.channelId === channelId).map((it) => it.id))].filter((id) => !d.seen.has(id));
      candidates.set(channelId, shuffled(ids, d.rand));
      const done = new Set(d.watched(ids));
      return tryChannel(candidates.get(channelId)!.filter((id) => !done.has(id)));
    }));
    const hit = found.find((v) => v);
    if (hit) return hit;
  }
  if (!examinedAll || stop()) return null;

  // Pass 2: every channel was examined and had nothing unwatched, so watched videos are better than silence.
  for (const channelId of channels) {
    const ids = candidates.get(channelId);
    if (!ids) continue;
    const v = await tryChannel(ids);
    if (v) return v;
    if (stop()) return null;
  }
  return null;
}

/** Token bucket plus an hourly cap, for the whole server: TV needs about one request a minute, so this is generous. */
export class TvLimiter {
  private tokens: number;
  private last: number;
  private hour: number[] = [];
  private readonly burst: number;
  private readonly perSecond: number;
  private readonly perHour: number;
  constructor(burst = 3, perSecond = 1, perHour = 240) {
    this.burst = burst;
    this.perSecond = perSecond;
    this.perHour = perHour;
    this.tokens = burst;
    this.last = 0;
  }
  /** 0 when the request may go ahead, else the seconds to wait. */
  take(now = Date.now()): number {
    if (this.last === 0) this.last = now;
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.perSecond);
    this.last = now;
    this.hour = this.hour.filter((t) => t > now - 3_600_000);
    if (this.hour.length >= this.perHour) return Math.max(1, Math.ceil((this.hour[0] + 3_600_000 - now) / 1000));
    if (this.tokens < 1) return Math.max(1, Math.ceil((1 - this.tokens) / this.perSecond));
    this.tokens -= 1;
    this.hour.push(now);
    return 0;
  }
}
