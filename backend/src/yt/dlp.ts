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
export const QUALITIES = [360, 480, 720, 1080] as const;
export const DEFAULT_QUALITY = 720;

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

export function parseQuality(q: string | null): number {
  const n = Number(q);
  return (QUALITIES as readonly number[]).includes(n) ? n : DEFAULT_QUALITY;
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

// Many videos carry several audio tracks (original + auto-dubs) at the same bitrate; without a language
// filter yt-dlp can pick any of them. Try the preferred language first, then anything.
export const formatSelector = (q: number, lang: string) => {
  const pref = (audio: string) => `bv*[height<=${q}][vcodec^=avc1]+${audio}/bv*[height<=${q}][ext=mp4]+${audio}`;
  return `${pref(`ba[ext=m4a][language^=${lang}]`)}/${pref("ba[ext=m4a]")}/b[height<=${q}][ext=mp4]/bv*[height<=${q}]+ba/b[height<=${q}]`;
};

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
export async function resolveUrls(id: string, q: number, lang: string): Promise<string[]> {
  if (!VIDEO_ID.test(id)) throw new Error("bad video id");
  const key = `${id}-${q}-${lang}`;
  const failed = recentFailure(key);
  if (failed) return Promise.reject(failed.err);
  return cached(`dlp:${key}`, 5 * 60_000, () =>
    resolveSlots.run(() => tracked(async () => {
      const { stdout } = await run(
        YTDLP(),
        ["--no-playlist", "--no-warnings", "-f", formatSelector(q, lang), "-g", "--", `https://www.youtube.com/watch?v=${id}`],
        { timeout: 60_000 },
      );
      const urls = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
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
export async function streamLive(id: string, q: number, lang: string, start: number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Registered before any await: if the viewer leaves while yt-dlp is still resolving, we must notice.
  let gone = res.destroyed;
  let ff: ChildProcess | undefined;
  res.on("close", () => {
    gone = true;
    ff?.kill("SIGKILL"); // viewer left or seeked: stop pulling from Google
  });

  let urls: string[];
  try {
    urls = await resolveUrls(id, q, lang);
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
