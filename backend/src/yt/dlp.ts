import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logSafe } from "../http.ts";
import { cached } from "../cache.ts";
import { envInt } from "../env.ts";
import { limiter } from "../limit.ts";
import { tracked } from "../status.ts";
import { INFO, SKIPPABLE, classifyError, classifyText, errorBody, type ErrorCode } from "../errors.ts";
import { streamEvents } from "../metrics.ts";

const run = promisify(execFile);

export const VIDEO_ID = /^[\w-]{11}$/;
export const QUALITIES = [360, 480, 720, 1080, 1440, 2160] as const;
export const DEFAULT_QUALITY = 720;
/** Up to this height H.264 + AAC is used when the video has it; above it only VP9/AV1 exist. */
const AVC_MAX = 1080;
/** Owner cap (`MAX_QUALITY`, default 2160): the highest quality the server will ever fetch. Read per call so tests can change it. */
export const maxQuality = (): number => envInt("MAX_QUALITY", 2160);
/** The qualities the server offers when it does not know the video's formats (all that H.264 can usually deliver), under the cap. */
export const baseQualities = (): number[] => QUALITIES.filter((h) => h <= Math.min(AVC_MAX, maxQuality()));

const YTDLP = () => process.env.YTDLP_BIN ?? "yt-dlp";
const FFMPEG = () => process.env.FFMPEG_BIN ?? "ffmpeg";

// Bound the work one client (or one hostile web page) can make the host do.
export const resolveSlots = limiter(3, 10);
const streamSlots = limiter(envInt("MAX_STREAMS", 3), 0);
const MAX_STREAM_MS = Math.max(1, envInt("STREAM_MAX_SECONDS", 6 * 3600)) * 1000;

/** Live child processes, so shutdown can reap them. */
export const children = new Set<ChildProcess>();
export function killChildren(): void {
  for (const c of children) c.kill("SIGKILL");
}

/** Explicit quality (`?q=1440`): one of QUALITIES, at most MAX_QUALITY (a higher one is lowered to it); anything else the default. */
export function parseQuality(q: string | null): number {
  const n = Number(q);
  const cap = Math.max(...QUALITIES.filter((t) => t <= maxQuality()), QUALITIES[0]);
  if ((QUALITIES as readonly number[]).includes(n)) return Math.min(n, cap);
  return Math.min(DEFAULT_QUALITY, cap);
}

export type Codec = "avc1" | "vp9" | "av01";
const ALL_CODECS: readonly Codec[] = ["avc1", "vp9", "av01"];
const CODEC_NAMES: Record<string, Codec> = { avc1: "avc1", avc: "avc1", h264: "avc1", vp9: "vp9", vp09: "vp9", av1: "av01", av01: "av01" };

/** Decoders the client says it has (`?codecs=avc1,vp9,av1`). Absent: assume all. Present but nothing known: H.264 only. */
export function parseCodecs(raw: string | null): readonly Codec[] {
  if (raw === null || raw === "") return ALL_CODECS;
  const set = new Set<Codec>();
  for (const part of raw.slice(0, 64).split(",")) {
    const c = CODEC_NAMES[part.trim().toLowerCase()];
    if (c) set.add(c);
  }
  return set.size ? ALL_CODECS.filter((c) => set.has(c)) : ["avc1"];
}

/** Heights above 1080p need VP9 or AV1; Auto never goes there for a client that has neither. */
const hiCodecs = (codecs: readonly Codec[]) => codecs.filter((c): c is "vp9" | "av01" => c !== "avc1");

/**
 * `?q=auto`: the highest tier the display (`maxh`, px of the shorter screen side) can use, at most 1080p unless the client
 * decodes VP9 or AV1, and never above MAX_QUALITY. (The stream's selector falls back to what the video really has.)
 */
export function autoQuality(maxh: string | null, codecs: readonly Codec[]): number {
  const h = Number(maxh);
  const screen = maxh !== null && maxh !== "" && Number.isFinite(h) && h > 0 ? h : AVC_MAX;
  const cap = Math.min(screen, maxQuality(), hiCodecs(codecs).length ? 2160 : AVC_MAX);
  return Math.max(...QUALITIES.filter((t) => t <= cap), QUALITIES[0]);
}

/** Start offset in whole seconds (`?t=90`), 0 if absent or invalid. */
export function parseStart(t: string | null): number {
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 86400 ? Math.floor(n) : 0;
}

const AUDIO_LANG = /^[a-z]{2,3}$/;
const DEFAULT_LANG = AUDIO_LANG.test(process.env.AUDIO_LANG ?? "") ? process.env.AUDIO_LANG! : "en";

/** Audio language (`?a=pt`): primary subtag only, falls back to AUDIO_LANG (default "en"). */
export function parseLang(a: string | null): string {
  return a && AUDIO_LANG.test(a) ? a : DEFAULT_LANG;
}

/** What a request asks for: `q` (a tier or "auto"), `maxh` (Auto only) and `codecs`. `quality` is always a concrete tier. */
export function requestedQuality(p: URLSearchParams): { quality: number; auto: boolean; codecs: readonly Codec[] } {
  const codecs = parseCodecs(p.get("codecs"));
  const auto = p.get("q") === "auto";
  return { quality: auto ? autoQuality(p.get("maxh"), codecs) : parseQuality(p.get("q")), auto, codecs };
}

// Many videos carry several audio tracks (original + auto-dubs) at the same bitrate; without a language
// filter yt-dlp can pick any of them. Try the preferred language first, then anything.
const FORMATS_TAG = "YTFMT ";
// Above 1080p the video is VP9/AV1 (tried first, VP9 before the heavier AV1) and the audio is still AAC when there is any;
// webm Opus audio also remuxes into fragmented mp4 with `-c copy`. The H.264 chain below is the fallback (and the whole story up to 1080p).
// yt-dlp reports DASH VP9 as "vp9" and HLS/other VP9 as "vp09.00...": the regex takes both.
const VCODEC_RE: Record<"vp9" | "av01", string> = { vp9: "'^vp0?9'", av01: "'^av01'" };
// Above 1080p only plain SDR 8-bit: HDR and 10-bit (VP9 profile 2/3, AV1 10/12-bit) look washed out on SDR screens and many decoders refuse them.
const SDR_8BIT = "[dynamic_range!*=?HDR][vcodec!~='^(vp09\\.0[23]|av01\\.\\d\\.\\d+[MH]\\.1[02])']";
// A tier is the SHORT side of the picture (a 1080x1920 clip is "1080p" and q=720 must not pick its 360x640 stream): landscape
// streams are bounded by height, portrait ones (aspect ratio below 1) by width. Landscape comes first; a stream with no known aspect counts as landscape.
const chain = (q: number, lang: string, hi: readonly ("vp9" | "av01")[], portrait: boolean) => {
  const dim = portrait ? "width" : "height";
  const fit = `${portrait ? "[aspect_ratio<1]" : "[aspect_ratio>=?1]"}[${dim}<=${q}]`;
  // Codecs the client lacks must not sneak in through the generic fallbacks either.
  const skip = q > AVC_MAX ? (["vp9", "av01"] as const).filter((c) => !hi.includes(c)).map((c) => `[vcodec!~=${VCODEC_RE[c]}]`).join("") + SDR_8BIT : "";
  const pref = (audio: string) => `bv*${fit}[vcodec^=avc1]+${audio}/bv*${fit}[ext=mp4]${skip}+${audio}`;
  const high = q > AVC_MAX
    ? hi.map((c) => {
        const v = `bv*${fit}[${dim}>${AVC_MAX}][vcodec~=${VCODEC_RE[c]}]${SDR_8BIT}[protocol!*=m3u8]`;
        return `${v}+ba[ext=m4a][language^=${lang}]/${v}+ba[ext=m4a]/${v}+ba`;
      })
    : [];
  return [...high, pref(`ba[ext=m4a][language^=${lang}]`), pref("ba[ext=m4a]"), `b${fit}[ext=mp4]${skip}`, `bv*${fit}${skip}+ba`, `b${fit}${skip}`].join("/");
};
export const formatSelector = (q: number, lang: string, codecs: readonly Codec[] = ALL_CODECS) => {
  const hi = hiCodecs(codecs);
  if (q > AVC_MAX && !hi.length) q = AVC_MAX; // nothing above 1080p is decodable: don't ask for it
  return `${chain(q, lang, hi, false)}/${chain(q, lang, hi, true)}`;
};

/** One entry per tier the video really has: its height in (previous tier, tier], with the codec families found there. */
export type Offered = { qualities: number[]; codecs: Record<string, string[]> };
type Fmt = { height?: unknown; width?: unknown; vcodec?: unknown; protocol?: unknown; dynamic_range?: unknown };
// HDR and 10-bit streams are never selected above 1080p (see SDR_8BIT), so they must not be offered either.
const TEN_BIT = /^(vp09\.0[23]|av01\.\d\.\d+[MH]\.1[02])/;
const family = (vcodec: string): Codec | null =>
  vcodec.startsWith("avc1") ? "avc1" : vcodec.startsWith("vp09") || vcodec === "vp9" ? "vp9" : vcodec.startsWith("av01") ? "av01" : null;

export function offeredFrom(formats: readonly Fmt[]): Offered {
  const cap = maxQuality();
  const found = new Map<number, Set<Codec>>();
  for (const f of formats) {
    if (typeof f.height !== "number" || f.height <= 0 || typeof f.vcodec !== "string") continue;
    if (typeof f.protocol === "string" && f.protocol.includes("m3u8")) continue; // the stream route can only remux plain HTTPS files
    if (TEN_BIT.test(f.vcodec) || (typeof f.dynamic_range === "string" && f.dynamic_range.includes("HDR"))) continue;
    const fam = family(f.vcodec);
    const side = typeof f.width === "number" && f.width > 0 ? Math.min(f.width, f.height) : f.height; // portrait clips are tiered by their short side too
    const tier = QUALITIES.find((t) => side <= t);
    if (!fam || tier === undefined || tier > cap) continue;
    (found.get(tier) ?? found.set(tier, new Set()).get(tier)!).add(fam);
  }
  const qualities = [...found.keys()].sort((a, b) => a - b);
  return { qualities, codecs: Object.fromEntries(qualities.map((t) => [String(t), ALL_CODECS.filter((c) => found.get(t)!.has(c)).map((c) => (c === "av01" ? "av1" : c))])) };
}

// What the last resolve of a video learned about its formats (kept a while longer than the signed URLs).
const offers = new Map<string, { until: number; offered: Offered }>();
const OFFER_TTL_MS = 30 * 60_000;
/** The tiers a video has, once any resolve of it has succeeded; undefined when unknown (never resolved, or yt-dlp printed none). */
export function knownOffered(id: string): Offered | undefined {
  const hit = offers.get(id);
  if (hit && hit.until <= Date.now()) offers.delete(id);
  return hit && hit.until > Date.now() ? hit.offered : undefined;
}
function noteOffered(id: string, formats: readonly Fmt[]): void {
  const offered = offeredFrom(formats);
  if (!offered.qualities.length) return;
  offers.delete(id);
  offers.set(id, { until: Date.now() + OFFER_TTL_MS, offered });
  if (offers.size > 200) offers.delete(offers.keys().next().value!);
}

// Videos whose last resolve failed for a reason retrying won't fix; lets /api/video answer "can't play" without yt-dlp.
const unplayable = new Map<string, { code: ErrorCode; until: number }>();
export function knownUnplayable(id: string): ErrorCode | undefined {
  const hit = unplayable.get(id);
  return hit && hit.until > Date.now() ? hit.code : undefined;
}
function noteUnplayable(id: string, err: unknown): void {
  const code = classifyError(err);
  if (!SKIPPABLE.has(code)) return;
  unplayable.delete(id);
  unplayable.set(id, { code, until: Date.now() + 10 * 60_000 });
  if (unplayable.size > 200) unplayable.delete(unplayable.keys().next().value!);
}

// A failed resolve is remembered briefly per (id, quality, lang): the prewarm, the <video> request and the web
// player's error probe all ask for the same thing, and a failing video (or a bot check) must not be re-asked each time.
export const FAIL_TTL_MS = 30_000;
const failures = new Map<string, { until: number; err: unknown }>();
export function recentFailure(key: string, now = Date.now()): { err: unknown } | undefined {
  const hit = failures.get(key);
  if (hit && hit.until <= now) failures.delete(key);
  return hit && hit.until > now ? hit : undefined;
}
export function recordFailure(key: string, err: unknown, now = Date.now()): void {
  failures.delete(key);
  failures.set(key, { until: now + FAIL_TTL_MS, err });
  if (failures.size > 200) failures.delete(failures.keys().next().value!);
}
export const clearFailures = () => failures.clear();

/** Direct googlevideo URLs: [video, audio] or a single muxed URL. Bound to this host's IP. */
export async function resolveUrls(id: string, q: number, lang: string, codecs: readonly Codec[] = ALL_CODECS): Promise<string[]> {
  if (!VIDEO_ID.test(id)) throw new Error("bad video id");
  if (q > AVC_MAX && !hiCodecs(codecs).length) q = AVC_MAX; // the selector would ask for 1080p anyway: share that entry
  // The codec set only changes the selector above 1080p.
  const key = `${id}-${q}-${lang}${q > AVC_MAX ? `-${hiCodecs(codecs).join("+")}` : ""}`;
  const failed = recentFailure(key);
  if (failed) return Promise.reject(failed.err);
  return cached(`dlp:${key}`, 5 * 60_000, () =>
    resolveSlots.run(() => tracked(async () => {
      const { stdout } = await run(
        YTDLP(),
        // The same extraction also prints the format list (one tagged JSON line), so the tiers a video has cost no extra run.
        ["--no-playlist", "--no-warnings", "-f", formatSelector(q, lang, codecs), "-g", "--print", `${FORMATS_TAG}%(formats.:.{height,width,vcodec,protocol,dynamic_range})j`, "--", `https://www.youtube.com/watch?v=${id}`],
        { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
      const tagged = lines.find((l) => l.startsWith(FORMATS_TAG));
      const urls = lines.filter((l) => !l.startsWith(FORMATS_TAG));
      if (tagged) {
        try {
          const list = JSON.parse(tagged.slice(FORMATS_TAG.length)) as unknown;
          if (Array.isArray(list)) noteOffered(id, list);
        } catch { /* an unreadable list only means the default qualities are offered */ }
      }
      if (!urls.length) throw new Error("yt-dlp returned no stream URL");
      return urls;
    }).catch((e) => {
      recordFailure(key, e);
      noteUnplayable(id, e);
      throw e;
    })),
  );
}

export function ffmpegArgs(urls: string[], start: number): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-protocol_whitelist", "https,tcp,tls,crypto"];
  for (const u of urls) {
    if (start > 0) args.push("-ss", String(start));
    args.push("-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-i", u);
  }
  if (urls.length === 2) args.push("-map", "0:v:0", "-map", "1:a:0");
  // Fragmented mp4 can be written to a pipe, so playback starts before the download finishes.
  args.push("-c", "copy", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", "pipe:1");
  return args;
}

/** Remux the upstream streams to fragmented mp4 on the fly. No file on disk, no waiting for a download. */
export async function streamLive(id: string, q: number, lang: string, codecs: readonly Codec[], start: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Registered before any await: if the viewer leaves while yt-dlp is still resolving, we must notice.
  let gone = res.destroyed;
  let ff: ChildProcess | undefined;
  res.on("close", () => {
    gone = true;
    ff?.kill("SIGKILL"); // viewer left or seeked: stop pulling from Google
  });

  let urls: string[];
  try {
    urls = await resolveUrls(id, q, lang, codecs);
  } catch (e) {
    if (!gone) streamEvents.failed(); // the caller turns it into a classified JSON error (nothing was sent yet)
    throw e;
  }
  if (gone) return;
  const headers = { "content-type": "video/mp4", "cache-control": "no-store", "accept-ranges": "none" };
  if (req.method === "HEAD") return void res.writeHead(200, headers).end();

  let release: () => void;
  try {
    release = await streamSlots.acquire(); // throws BusyError (-> 503) when all slots are in use
  } catch (e) {
    streamEvents.failed();
    throw e;
  }
  try {
    if (gone) return;
    await new Promise<void>((resolve) => {
      const proc = spawn(FFMPEG(), ffmpegArgs(urls, start), { stdio: ["ignore", "pipe", "pipe"] });
      ff = proc;
      children.add(proc);
      const timer = setTimeout(() => proc.kill("SIGKILL"), MAX_STREAM_MS);
      timer.unref();
      let stderr = "";
      let started = false;
      let done = false;
      const finish = (why: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        children.delete(proc);
        if (started) streamEvents.finished();
        if (!started && !gone) {
          console.error(`ffmpeg ${logSafe(id, 16)}: ${logSafe(why)}${stderr.trim() ? `: ${logSafe(stderr.trim(), 500)}` : ""}`);
          streamEvents.failed();
          // Same JSON shape as every other error before headers; ffmpeg's own text (it holds URLs) stays in the log.
          const code = classifyText(stderr) ?? "unknown";
          res.writeHead(INFO[code].status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(errorBody(code)));
        } else if (!gone) res.end();
        resolve();
      };
      proc.stderr.on("data", (d) => (stderr = (stderr + d).slice(-500)));
      proc.stdout.on("data", (chunk: Buffer) => {
        if (gone) return;
        if (!started) {
          started = true;
          streamEvents.started();
          res.writeHead(200, headers);
        }
        if (!res.write(chunk)) {
          proc.stdout.pause();
          res.once("drain", () => proc.stdout.resume());
        }
      });
      proc.on("error", (e) => finish(`spawn failed (${e.message})`)); // e.g. ffmpeg missing: must not crash the server
      proc.on("close", (code, signal) => finish(`exit ${code ?? signal}`));
    });
  } finally {
    release();
  }
}
