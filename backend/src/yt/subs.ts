import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cached, forget } from "../cache.ts";
import { envInt } from "../env.ts";
import { NoSubtitles, UpstreamError } from "../errors.ts";
import { fetchT } from "../http.ts";
import { BusyError, limiter } from "../limit.ts";
import { VIDEO_ID, recentFailure, recordFailure } from "./dlp.ts";

const run = promisify(execFile);

export interface SubTrack {
  lang: string;
  name: string;
  auto: boolean;
}
interface Entry {
  url: string; // stays in memory: never sent to a client or written to disk
  name: string;
}
interface Info {
  manual: Map<string, Entry>;
  auto: Map<string, Entry>;
}

export const SUB_LANG = /^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/;
export const MAX_TRACKS = 30;
export const MAX_VTT_BYTES = 2 * 1024 * 1024;
const TTL = 60 * 60_000;
const NEGATIVE_TTL = 10 * 60_000;
const BODY_CACHE_BYTES = 8 * 1024 * 1024;

/** Subtitles have their own single yt-dlp slot, so they can never take the ones playback or search need. */
export const subSlots = limiter(1, 4);
const ytdlpMs = () => envInt("SUBS_YTDLP_TIMEOUT_MS", 30_000);
const fetchMs = () => envInt("SUBS_FETCH_TIMEOUT_MS", 10_000);

/** https on YouTube's own hosts only: the URLs come from yt-dlp's output, but a fetch is never aimed anywhere else. */
export function allowedSubUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const h = u.hostname.toLowerCase();
  return ["youtube.com", "googlevideo.com"].some((d) => h === d || h.endsWith(`.${d}`)) ? u : null;
}

type Formats = Array<{ ext?: unknown; url?: unknown; name?: unknown }>;
const cleanName = (n: unknown, lang: string): string => (typeof n === "string" ? n.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ").trim().slice(0, 60) : "") || lang;

/**
 * yt-dlp's two maps (language -> formats) reduced to one URL and name per valid language. Keys that are not plain
 * language codes (live_chat, "a.en"-style translation keys) are skipped; the URL is the vtt format when listed, else
 * any format asked for as vtt (timedtext URLs can serve WebVTT whatever yt-dlp listed).
 */
export function parseSubs(subtitles: unknown, automatic: unknown): Info {
  const reduce = (map: unknown): Map<string, Entry> => {
    const out = new Map<string, Entry>();
    if (!map || typeof map !== "object" || Array.isArray(map)) return out;
    for (const [lang, formats] of Object.entries(map)) {
      if (!SUB_LANG.test(lang) || !Array.isArray(formats)) continue;
      const list = (formats as Formats).filter((f) => f && typeof f.url === "string");
      const pick = list.find((f) => f.ext === "vtt") ?? list[0];
      const u = pick && allowedSubUrl(pick.url as string);
      if (!u) continue;
      if (pick.ext !== "vtt") u.searchParams.set("fmt", "vtt");
      out.set(lang, { url: u.href, name: cleanName(pick.name, lang) });
    }
    return out;
  };
  const manual = reduce(subtitles);
  const auto = reduce(automatic);
  for (const l of manual.keys()) auto.delete(l); // one track per language: the manual one
  return { manual, auto };
}

const base = (l: string) => l.split(/[-_]/)[0].toLowerCase();

/**
 * The tracks to offer, capped at MAX_TRACKS: manual ones first; then automatic ones, the viewer's [pref] language first,
 * then originals (`en-orig`), then languages that also have a manual track (same primary subtag), then the rest sorted.
 * [pref] is always included when the video has it, so a saved language is never cut by the cap.
 */
export function selectTracks(info: Info, pref = ""): SubTrack[] {
  const manualBases = new Set([...info.manual.keys()].map(base));
  const rank = (l: string) => (l === pref ? 0 : l.endsWith("-orig") ? 1 : manualBases.has(base(l)) ? 2 : 3);
  const autoLangs = [...info.auto.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const all: SubTrack[] = [
    ...[...info.manual].map(([lang, e]) => ({ lang, name: e.name, auto: false })),
    ...autoLangs.map((lang) => ({ lang, name: info.auto.get(lang)!.name, auto: true })),
  ];
  const out = all.slice(0, MAX_TRACKS);
  const want = all.find((t) => t.lang === pref);
  if (want && !out.includes(want)) out[MAX_TRACKS - 1] = want;
  return out;
}

async function load(id: string): Promise<Info> {
  const { stdout } = await subSlots.run(() =>
    run(
      process.env.YTDLP_BIN ?? "yt-dlp",
      ["--no-playlist", "--no-warnings", "--skip-download", "--print", "%(subtitles)j", "--print", "%(automatic_captions)j", "--", `https://www.youtube.com/watch?v=${id}`],
      { timeout: ytdlpMs(), killSignal: "SIGKILL", maxBuffer: 16 * 1024 * 1024 },
    ),
  );
  const [a, b] = stdout.split("\n");
  const parse = (s?: string): unknown => {
    try {
      return JSON.parse(s ?? "null");
    } catch {
      return null;
    }
  };
  return parseSubs(parse(a), parse(b));
}

/** The video's subtitle URLs, in memory only: 1 h with tracks, 10 min without. A failure is remembered for 30 s so reloads can't re-run yt-dlp. */
async function info(id: string): Promise<Info> {
  const key = `subs:${id}`;
  const failed = recentFailure(key);
  if (failed) throw failed.err;
  try {
    return await cached(key, (i) => (i.manual.size + i.auto.size ? TTL : NEGATIVE_TTL), () => load(id));
  } catch (e) {
    if (!(e instanceof BusyError)) recordFailure(key, e); // busy says nothing about the video
    throw e;
  }
}

/** The available tracks (possibly none), [pref] first among the automatic ones. The list alone is persisted. */
export async function subTracks(id: string, pref = ""): Promise<SubTrack[]> {
  if (!VIDEO_ID.test(id)) throw new Error("bad video id");
  return cached(`subtracks:${id}:${pref}`, TTL, async () => selectTracks(await info(id), pref), true);
}

async function download(url: string): Promise<string> {
  const res = await fetchT(url, { redirect: "error", headers: { accept: "text/vtt,*/*" } }, fetchMs()); // the timeout covers the body too
  if (res.status === 404) throw new NoSubtitles();
  if (!res.ok) throw new UpstreamError(`subtitle download failed: ${res.status}`, res.status);
  const reader = res.body?.getReader();
  if (!reader) throw new Error("subtitle download failed: no body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_VTT_BYTES) {
      await reader.cancel();
      throw new NoSubtitles("subtitle download failed: too large");
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.replace(/^﻿/, "").startsWith("WEBVTT")) throw new NoSubtitles("subtitle download failed: not WebVTT");
  return text;
}

// Recent WebVTT bodies, bounded by total bytes (oldest out first); concurrent requests for one track share a single download.
const bodies = new Map<string, { exp: number; vtt: string }>();
const inflight = new Map<string, Promise<string>>();
let bodyBytes = 0;
function remember(key: string, vtt: string): void {
  const old = bodies.get(key);
  if (old) bodyBytes -= old.vtt.length;
  bodies.delete(key);
  bodies.set(key, { exp: Date.now() + TTL, vtt });
  bodyBytes += vtt.length;
  for (const [k, v] of bodies) {
    if (bodyBytes <= BODY_CACHE_BYTES) break;
    bodies.delete(k);
    bodyBytes -= v.vtt.length;
  }
}

async function fetchTrack(id: string, lang: string, retry: boolean): Promise<string> {
  const i = await info(id);
  const url = (i.manual.get(lang) ?? i.auto.get(lang))?.url;
  const u = url && allowedSubUrl(url);
  if (!u) throw new NoSubtitles();
  try {
    return await download(u.href);
  } catch (e) {
    // A cached URL that has expired: ask yt-dlp again, once.
    if (retry && e instanceof UpstreamError && (e.status === 403 || e.status === 410)) {
      forget(`subs:${id}`);
      return fetchTrack(id, lang, false);
    }
    throw e;
  }
}

/** WebVTT for one language of a video. Throws NoSubtitles when the video has no such (usable) track. */
export async function subVtt(id: string, lang: string): Promise<string> {
  if (!VIDEO_ID.test(id) || !SUB_LANG.test(lang)) throw new Error("bad subtitle request");
  const key = `${id}\n${lang}`;
  const hit = bodies.get(key);
  if (hit && hit.exp > Date.now()) return hit.vtt;
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = fetchTrack(id, lang, true)
    .then((vtt) => (remember(key, vtt), vtt))
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

/** Test hook: forget every remembered body. */
export function resetSubs(): void {
  bodies.clear();
  inflight.clear();
  bodyBytes = 0;
}
