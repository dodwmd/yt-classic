import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cached, forget } from "../cache.ts";
import { envInt } from "../env.ts";
import { NoStoryboard, UpstreamError } from "../errors.ts";
import { fetchT } from "../http.ts";
import { BusyError, limiter } from "../limit.ts";
import { VIDEO_ID, recentFailure, recordFailure } from "./dlp.ts";

const run = promisify(execFile);

/** What a client needs to map a time to a tile: tile size, grid per sheet, tiles in total, seconds per tile, number of sheets. */
export interface Tiles {
  w: number;
  h: number;
  cols: number;
  rows: number;
  count: number;
  interval: number;
  sheets: number;
}
export interface Descriptor {
  tiles: Tiles;
  duration: number;
}
interface Info {
  desc: Descriptor | null;
  urls: string[]; // stay in memory: never sent to a client or written to disk
}

export const MAX_SHEET_BYTES = 1_500_000;
export const MAX_SHEETS = 400;
const TTL = 60 * 60_000;
const NEGATIVE_TTL = 10 * 60_000;
const SHEET_CACHE_BYTES = 16 * 1024 * 1024;
const TYPES = /^image\/(jpeg|webp|png)$/;

/** Storyboards have their own yt-dlp slot: they can never take the ones playback, search or subtitles need. */
export const sbSlots = limiter(1, 4);
const ytdlpMs = () => envInt("STORYBOARD_YTDLP_TIMEOUT_MS", 30_000);
const fetchMs = () => envInt("STORYBOARD_FETCH_TIMEOUT_MS", 10_000);

const HOSTS = ["ytimg.com", "googlevideo.com", "ggpht.com"];
/** https on YouTube's image hosts only (exact name or a subdomain, never a lookalike): a fetch is never aimed anywhere else. */
export function allowedSheetUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const h = u.hostname.toLowerCase();
  return HOSTS.some((d) => h === d || h.endsWith(`.${d}`)) ? u : null;
}

interface Fmt {
  format_id?: unknown;
  width?: unknown;
  height?: unknown;
  fps?: unknown;
  rows?: unknown;
  columns?: unknown;
  fragments?: unknown;
}
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One storyboard level as a descriptor, or null when it is not usable (odd numbers, a foreign host, sheets that are not full grids). */
function level(f: Fmt, duration: number): Info | null {
  const [w, h, cols, rows, fps] = [num(f.width), num(f.height), num(f.columns), num(f.rows), num(f.fps)];
  if (!Number.isInteger(w) || !Number.isInteger(h) || !Number.isInteger(cols) || !Number.isInteger(rows) || w < 16 || h < 9 || w > 1000 || h > 1000 || cols < 1 || rows < 1 || cols * rows > 400 || fps <= 0) return null;
  if (!Array.isArray(f.fragments) || !f.fragments.length || f.fragments.length > MAX_SHEETS) return null;
  const per = cols * rows;
  const urls: string[] = [];
  let count = 0;
  for (const [i, fr] of (f.fragments as Array<{ url?: unknown; duration?: unknown }>).entries()) {
    const u = typeof fr?.url === "string" ? allowedSheetUrl(fr.url) : null;
    if (!u) return null;
    const n = Math.round(num(fr.duration) * fps);
    if (n < 1 || n > per || (i < f.fragments.length - 1 && n !== per)) return null; // the client maps by arithmetic: only full sheets before the last
    urls.push(u.href);
    count += n;
  }
  const interval = Math.round(1000 / fps) / 1000;
  return { urls, desc: { tiles: { w, h, cols, rows, count, interval, sheets: urls.length }, duration: duration > 0 ? duration : count * interval } };
}

/**
 * The best level from yt-dlp's `formats` (the `sb0..sb3` entries): the widest tile up to 320 px that keeps the sheet count
 * reasonable (at most 40, else the next narrower one), at least 100 px wide; the smallest usable level otherwise.
 */
export function parseStoryboards(duration: unknown, formats: unknown): Info {
  const none: Info = { desc: null, urls: [] };
  if (!Array.isArray(formats)) return none;
  const d = num(duration);
  const levels = (formats as Fmt[])
    .filter((f) => f && typeof f.format_id === "string" && /^sb\d$/.test(f.format_id))
    .map((f) => level(f, d))
    .filter((x): x is Info => !!x)
    .sort((a, b) => b.desc!.tiles.w - a.desc!.tiles.w);
  const fit = levels.filter((l) => l.desc!.tiles.w <= 320 && l.desc!.tiles.w >= 100);
  return fit.find((l) => l.desc!.tiles.sheets <= 40) ?? fit.at(-1) ?? levels.at(-1) ?? none;
}

async function load(id: string): Promise<Info> {
  const { stdout } = await sbSlots.run(() =>
    run(
      process.env.YTDLP_BIN ?? "yt-dlp",
      ["--no-playlist", "--no-warnings", "--skip-download", "--print", "%(duration)s", "--print", "%(formats)j", "--", `https://www.youtube.com/watch?v=${id}`],
      { timeout: ytdlpMs(), killSignal: "SIGKILL", maxBuffer: 32 * 1024 * 1024 },
    ),
  );
  const [a, b] = stdout.split("\n");
  let formats: unknown = null;
  try {
    formats = JSON.parse(b ?? "null");
  } catch {
    /* no formats: no storyboard */
  }
  return parseStoryboards(Number(a), formats);
}

/** The video's storyboard (URLs included, in memory only): 1 h with one, 10 min without. A failure is remembered for 30 s so reloads can't re-run yt-dlp. */
async function info(id: string): Promise<Info> {
  const key = `sb:${id}`;
  const failed = recentFailure(key);
  if (failed) throw failed.err;
  try {
    return await cached(key, (i) => (i.desc ? TTL : NEGATIVE_TTL), () => load(id));
  } catch (e) {
    if (!(e instanceof BusyError)) recordFailure(key, e); // busy says nothing about the video
    throw e;
  }
}

/** The descriptor clients map times with. Throws NoStoryboard when the video has none. Only this small object is persisted. */
export async function storyboard(id: string): Promise<Descriptor> {
  if (!VIDEO_ID.test(id)) throw new Error("bad video id");
  const d = await cached<Descriptor | null>(`sbdesc:${id}`, (v) => (v ? TTL : NEGATIVE_TTL), async () => (await info(id)).desc, true);
  if (!d) throw new NoStoryboard();
  return d;
}

async function download(url: string): Promise<{ type: string; body: Buffer }> {
  const res = await fetchT(url, { redirect: "error", headers: { accept: "image/jpeg,image/webp,image/png" } }, fetchMs()); // the timeout covers the body too
  if (res.status === 404) throw new NoStoryboard();
  if (!res.ok) throw new UpstreamError(`storyboard download failed: ${res.status}`, res.status);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!TYPES.test(type)) {
    await res.body?.cancel();
    throw new NoStoryboard("storyboard download failed: not an image");
  }
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_SHEET_BYTES) {
    await res.body?.cancel();
    throw new NoStoryboard("storyboard download failed: too large");
  }
  const reader = res.body?.getReader();
  if (!reader) throw new Error("storyboard download failed: no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_SHEET_BYTES) {
      await reader.cancel();
      throw new NoStoryboard("storyboard download failed: too large");
    }
    chunks.push(value);
  }
  return { type, body: Buffer.concat(chunks) };
}

// Recent sheets, bounded by total bytes (oldest out first); concurrent requests for one sheet share one download.
type Sheet = { type: string; body: Buffer };
const sheets = new Map<string, { exp: number; sheet: Sheet }>();
const inflight = new Map<string, Promise<Sheet>>();
let sheetBytes = 0;
function remember(key: string, sheet: Sheet): void {
  const old = sheets.get(key);
  if (old) sheetBytes -= old.sheet.body.length;
  sheets.delete(key);
  sheets.set(key, { exp: Date.now() + TTL, sheet });
  sheetBytes += sheet.body.length;
  for (const [k, v] of sheets) {
    if (sheetBytes <= SHEET_CACHE_BYTES) break;
    sheets.delete(k);
    sheetBytes -= v.sheet.body.length;
  }
}

async function fetchSheet(id: string, n: number, retry: boolean): Promise<Sheet> {
  const i = await info(id);
  const url = i.urls[n];
  const u = url && allowedSheetUrl(url);
  if (!u) throw new NoStoryboard();
  try {
    return await download(u.href);
  } catch (e) {
    // A cached URL that has expired: ask yt-dlp again, once.
    if (retry && e instanceof UpstreamError && (e.status === 403 || e.status === 410)) {
      forget(`sb:${id}`);
      return fetchSheet(id, n, false);
    }
    throw e;
  }
}

/** Sheet [n] of a video's storyboard. Throws NoStoryboard when the video has none or [n] is outside it. */
export async function sheet(id: string, n: number): Promise<Sheet> {
  if (!VIDEO_ID.test(id) || !Number.isInteger(n) || n < 0) throw new Error("bad storyboard request");
  const key = `${id}\n${n}`;
  const hit = sheets.get(key);
  if (hit && hit.exp > Date.now()) return hit.sheet;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetchSheet(id, n, true)
    .then((s) => (remember(key, s), s))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test hook: forget every remembered sheet. */
export function resetStoryboards(): void {
  sheets.clear();
  inflight.clear();
  sheetBytes = 0;
}
