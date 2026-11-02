import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logSafe } from "../http.ts";
import { UpstreamError, classifyError, errorText } from "../errors.ts";
import { fallbackAllowed } from "../quota.ts";
import { cached } from "../cache.ts";
import { apiChannelSearch, apiSearch, type ChannelHit, type ChannelPage, type Duration, type SearchOpts, type SearchPage, type Sort, type VideoSummary } from "./api.ts";
import { CHANNEL_ID } from "../store.ts";
import { BusyError, limiter } from "../limit.ts";

const run = promisify(execFile);
const PAGE = 20;
const MAX_PAGES = 5;
export const MAX_QUERY = 200;

export function parseSearch(json: any, page: number): SearchPage {
  const entries: any[] = (json.entries ?? []).filter((e: any) => typeof e?.id === "string" && e.id.length === 11);
  const items: VideoSummary[] = entries.slice((page - 1) * PAGE).map((e) => ({
    id: e.id,
    title: e.title ?? "",
    channelId: e.channel_id ?? "",
    channelTitle: e.channel ?? e.uploader ?? "",
    description: e.description ?? "",
    publishedAt: "", // flat search results carry no publish date
    thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    durationSeconds: typeof e.duration === "number" ? e.duration : undefined,
    views: e.view_count != null ? String(e.view_count) : undefined,
  }));
  return {
    items,
    nextPageToken: page < MAX_PAGES && items.length >= PAGE ? String(page + 1) : undefined,
    prevPageToken: page > 1 ? String(page - 1) : undefined,
  };
}

export const DURATIONS: readonly Duration[] = ["any", "short", "medium", "long"];
export const SORTS: readonly Sort[] = ["relevance", "date", "views"];
export type SearchType = "video" | "channel";
export const SHORT_MAX = 240; // seconds: short < 4 min, medium 4-20 min, long > 20 min (YouTube's own filter buckets)
export const LONG_MIN = 1200;

const RESULTS = "https://www.youtube.com/results";

/**
 * The `sp` parameter of YouTube's own search page, which carries its filters as a base64 protobuf:
 * field 1 = sort (2 date, 3 views), field 2 = filters { 2 = type (1 video, 2 channel), 3 = duration (1 short, 2 long, 3 medium) }.
 */
export function spParam(type: SearchType, opts: SearchOpts = { duration: "any", sort: "relevance" }): string {
  const filter = [0x10, type === "video" ? 1 : 2];
  if (type === "video" && opts.duration !== "any") filter.push(0x18, { short: 1, long: 2, medium: 3 }[opts.duration]);
  const msg: number[] = [];
  if (opts.sort !== "relevance") msg.push(0x08, opts.sort === "date" ? 2 : 3);
  msg.push(0x12, filter.length, ...filter);
  return encodeURIComponent(Buffer.from(msg).toString("base64"));
}

export function inBucket(seconds: number, d: Duration): boolean {
  return d === "any" || (d === "short" ? seconds < SHORT_MAX : d === "long" ? seconds > LONG_MIN : seconds >= SHORT_MAX && seconds <= LONG_MIN);
}

/** Applies the duration filter to results. Items with no duration are kept unless `strict` (when nothing upstream filtered). */
function filterDuration(items: VideoSummary[], d: Duration, strict: boolean): VideoSummary[] {
  return d === "any" ? items : items.filter((v) => (v.durationSeconds === undefined ? !strict : inBucket(v.durationSeconds, d)));
}

const MAX_DESC = 300;
const httpsUrl = (u: unknown): string => {
  if (typeof u !== "string") return "";
  const url = u.startsWith("//") ? `https:${u}` : u;
  try {
    return new URL(url).protocol === "https:" ? url : "";
  } catch {
    return "";
  }
};

/** One channel hit from either source, or null when it is not trustworthy (bad id). Everything is length-capped. */
export function cleanChannel(c: { id?: unknown; title?: unknown; thumb?: unknown; description?: unknown; subscribers?: unknown; handle?: unknown }): ChannelHit | null {
  if (typeof c.id !== "string" || !CHANNEL_ID.test(c.id)) return null;
  const subs = typeof c.subscribers === "number" || typeof c.subscribers === "string" ? String(c.subscribers) : "";
  const handle = typeof c.handle === "string" && /^@[\w.-]{3,40}$/.test(c.handle) ? c.handle : undefined;
  return {
    id: c.id,
    title: typeof c.title === "string" ? c.title.slice(0, 200) : "",
    thumb: httpsUrl(c.thumb),
    description: typeof c.description === "string" ? c.description.slice(0, MAX_DESC) : "",
    subscribers: /^\d{1,12}$/.test(subs) ? subs : undefined,
    handle,
  };
}

/** yt-dlp's flat channel search (results page with the channel filter): entries are YoutubeTab urls with follower counts. */
export function parseChannelSearch(json: any, page: number): ChannelPage {
  const all: ChannelHit[] = [];
  for (const e of json?.entries ?? []) {
    const thumbs: any[] = Array.isArray(e?.thumbnails) ? e.thumbnails : [];
    const best = thumbs.filter((t) => httpsUrl(t?.url)).sort((a, b) => (b.width ?? 0) - (a.width ?? 0))[0];
    const hit = cleanChannel({ id: e?.channel_id ?? e?.id, title: e?.channel ?? e?.title ?? e?.uploader, thumb: best?.url, description: e?.description, subscribers: e?.channel_follower_count, handle: e?.uploader_id });
    if (hit && !all.some((h) => h.id === hit.id)) all.push(hit);
  }
  const channels = all.slice((page - 1) * PAGE);
  return { channels, nextPageToken: page < MAX_PAGES && channels.length >= PAGE ? String(page + 1) : undefined };
}

/**
 * Search has its own yt-dlp slots, so a flood of searches can never take the ones playback needs. When both are busy the
 * request fails fast with BusyError (a 503 with Retry-After): busy is not "yt-dlp is down" and never spends API quota.
 */
export const searchSlots = limiter(2, 4);
const SEARCH_TIMEOUT = 20_000;

/** Never throws the raw execFile error: its message is the whole command line, which holds the query. */
async function dlp(url: string, count: number, q: string): Promise<any> {
  let stdout: string;
  try {
    ({ stdout } = await searchSlots.run(() =>
      run(process.env.YTDLP_BIN ?? "yt-dlp", ["--flat-playlist", "--no-warnings", "--playlist-end", String(count), "-J", url], {
        timeout: SEARCH_TIMEOUT,
        maxBuffer: 32 * 1024 * 1024,
      }),
    ));
  } catch (e) {
    if (e instanceof BusyError) throw e;
    throw scrubbed(e, q);
  }
  try {
    return JSON.parse(stdout);
  } catch {
    throw Object.assign(new Error("yt-dlp search failed: parse (unreadable output)"), { kind: "parse" });
  }
}

const strip = (text: string, q: string): string => {
  let t = text.replace(/https?:\/\/\S+/g, "<url>");
  for (const part of [q, encodeURIComponent(q)]) if (part.trim()) t = t.split(part).join("<q>").split(part.toLowerCase()).join("<q>");
  return t;
};

/**
 * A failure that is safe to log and rethrow: the classified code (errors.ts), the exit code and the first line of yt-dlp's
 * own stderr with URLs and the query removed. The command line is never kept; stderr stays (scrubbed) so the classifier still sees it.
 */
export function scrubbed(e: unknown, q: string): Error {
  const err = e as { killed?: boolean; code?: unknown; stderr?: unknown };
  const kind = err.killed ? "timeout" : typeof err.code === "number" ? "exit" : "spawn";
  const stderr = strip(typeof err.stderr === "string" ? err.stderr : "", q);
  const first = stderr.split("\n").find((l) => l.trim()) ?? "";
  const text = strip(errorText(e).split("\n").find((l) => l.trim()) ?? "", q);
  const safe = new Error(`yt-dlp search failed: ${classifyError(e)} (${kind}${typeof err.code === "number" ? ` ${err.code}` : ""}) ${logSafe(first || text, 160)}`.trimEnd());
  return Object.assign(safe, { kind, killed: err.killed, code: typeof err.code === "number" ? err.code : undefined, stderr });
}

const failed = (what: string, e: unknown) => console.error(logSafe(`${what}: ${e instanceof Error ? e.message : "failed"}`));

const pageOf = (token: string): number => (/^\d{1,2}$/.test(token) ? Math.min(MAX_PAGES, Math.max(1, Number(token))) : 1);
const NO_FILTER: SearchOpts = { duration: "any", sort: "relevance" };
const GOOD = 10 * 60_000;
const DEGRADED = 60_000; // a page that is only an approximation is not worth keeping for long

/**
 * Video search. Page tokens: "2".."5" are yt-dlp pages; "g:<token>" are Data API page tokens (only produced by the fallback).
 * Anything else is treated as page 1.
 *
 * Filters: yt-dlp is pointed at YouTube's own results page with the `sp` filter, so duration and sort are applied by
 * YouTube itself (no quota). If that fails, plain `ytsearch` results are filtered by duration locally and views are
 * sorted within the page (date cannot be done: flat results carry no publish date, which is said in `notes`). Only if
 * yt-dlp is down altogether does the capped Data API fallback take over, with its native videoDuration/order params.
 * A busy server is none of these: BusyError goes straight to the caller.
 */
export async function search(q: string, pageToken = "", opts: SearchOpts = NO_FILTER): Promise<SearchPage> {
  if (pageToken.startsWith("g:")) return apiPage(q, pageToken.slice(2), opts);
  const page = pageOf(pageToken);
  const filtered = opts.duration !== "any" || opts.sort !== "relevance";
  const key = filtered ? `ytsearch:${q}:${page}:${opts.duration}:${opts.sort}` : `ytsearch:${q}:${page}`;
  try {
    // Only complete results are kept for the full time: anything degraded is cached below, briefly.
    return await cached(key, GOOD, async () => {
      if (filtered) {
        const url = `${RESULTS}?search_query=${encodeURIComponent(q)}&sp=${spParam("video", opts)}`;
        const p = parseSearch(await dlp(url, PAGE * page, q), page);
        p.items = filterDuration(p.items, opts.duration, false);
        return p;
      }
      return parseSearch(await dlp(`ytsearch${PAGE * page}:${q}`, PAGE * page, q), page);
    });
  } catch (e) {
    if (e instanceof BusyError) throw e;
    failed(filtered ? "filtered search" : "search", e);
    return cached(`${key}:fallback`, DEGRADED, async () => {
      if (filtered) {
        try {
          const p = parseSearch(await dlp(`ytsearch${PAGE * page}:${q}`, PAGE * page, q), page);
          p.items = filterDuration(p.items, opts.duration, true);
          p.notes = ["YouTube's filtered search was unavailable, so the duration filter was applied to the usual results only."];
          if (opts.sort === "views") p.items.sort((a, b) => Number(b.views ?? 0) - Number(a.views ?? 0));
          if (opts.sort !== "relevance") p.notes.push(opts.sort === "views" ? "Videos are ordered by views within this page only." : "Sorting by date is not possible right now; results are in relevance order.");
          return p;
        } catch (e2) {
          if (e2 instanceof BusyError) throw e2;
          failed("search", e2);
        }
      }
      if (page > 1) throw e;
      return apiPage(q, "", opts);
    });
  }
}

/** Channel search, same token scheme. yt-dlp's channel filter is free and returns follower counts and handles, so it comes first. */
export async function searchChannels(q: string, pageToken = ""): Promise<ChannelPage> {
  if (pageToken.startsWith("g:")) return apiChannelPage(q, pageToken.slice(2));
  const page = pageOf(pageToken);
  const key = `ytchsearch:${q}:${page}`;
  try {
    return await cached(key, GOOD, async () => parseChannelSearch(await dlp(`${RESULTS}?search_query=${encodeURIComponent(q)}&sp=${spParam("channel")}`, PAGE * page, q), page));
  } catch (e) {
    if (e instanceof BusyError || page > 1) throw e;
    failed("channel search", e);
    return apiChannelPage(q, "");
  }
}

/** The daily cap (SEARCH_FALLBACK_MAX, quota.ts): taken only when an API call is really made. */
function reserveApiSearch(): void {
  if (!fallbackAllowed()) throw new UpstreamError("Data API search cap reached for today", 429, "dailyLimitExceeded");
}

async function apiChannelPage(q: string, token: string): Promise<ChannelPage> {
  const p = await apiChannelSearch(q, token, reserveApiSearch);
  return {
    channels: p.channels.map(cleanChannel).filter((c): c is ChannelHit => !!c),
    nextPageToken: p.nextPageToken && `g:${p.nextPageToken}`,
    notes: ["Found through the YouTube Data API (daily quota applies)."],
  };
}

async function apiPage(q: string, token: string, opts: SearchOpts): Promise<SearchPage> {
  const p = await apiSearch(q, token, opts, reserveApiSearch);
  return {
    items: p.items,
    nextPageToken: p.nextPageToken && `g:${p.nextPageToken}`,
    prevPageToken: p.prevPageToken && `g:${p.prevPageToken}`,
  };
}
