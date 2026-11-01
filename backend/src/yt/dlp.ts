import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage, ServerResponse } from "node:http";
import { cached } from "../cache.ts";

const run = promisify(execFile);

export const VIDEO_ID = /^[\w-]{11}$/;
export const QUALITIES = [360, 480, 720, 1080] as const;
export const DEFAULT_QUALITY = 720;

export function parseQuality(q: string | null): number {
  const n = Number(q);
  return (QUALITIES as readonly number[]).includes(n) ? n : DEFAULT_QUALITY;
}

/** Start offset in whole seconds (`?t=90`), 0 if absent or invalid. */
export function parseStart(t: string | null): number {
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 86400 ? Math.floor(n) : 0;
}

const DEFAULT_LANG = process.env.AUDIO_LANG ?? "en";

/** Audio language (`?a=pt`): primary subtag only, falls back to AUDIO_LANG (default "en"). */
export function parseLang(a: string | null): string {
  return a && /^[a-z]{2,3}$/.test(a) ? a : DEFAULT_LANG;
}

// Many videos carry several audio tracks (original + auto-dubs) at the same bitrate; without a language
// filter yt-dlp can pick any of them. Try the preferred language first, then anything.
export const formatSelector = (q: number, lang: string) => {
  const pref = (audio: string) => `bv*[height<=${q}][vcodec^=avc1]+${audio}/bv*[height<=${q}][ext=mp4]+${audio}`;
  return `${pref(`ba[ext=m4a][language^=${lang}]`)}/${pref("ba[ext=m4a]")}/b[height<=${q}][ext=mp4]/bv*[height<=${q}]+ba/b[height<=${q}]`;
};

const inflight = new Map<string, Promise<string[]>>();

/** Direct googlevideo URLs: [video, audio] or a single muxed URL. Bound to this host's IP. */
export function resolveUrls(id: string, q: number, lang: string): Promise<string[]> {
  if (!VIDEO_ID.test(id)) throw new Error("bad video id");
  const k = `${id}-${q}-${lang}`;
  const existing = inflight.get(k);
  if (existing) return existing;
  const p = cached(`dlp:${k}`, 5 * 60_000, async () => {
    const { stdout } = await run(
      "yt-dlp",
      ["--no-playlist", "--no-warnings", "-f", formatSelector(q, lang), "-g", `https://www.youtube.com/watch?v=${id}`],
      { timeout: 60_000 },
    );
    const urls = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    if (!urls.length) throw new Error("yt-dlp returned no stream URL");
    return urls;
  }).finally(() => inflight.delete(k));
  inflight.set(k, p);
  return p;
}

export function ffmpegArgs(urls: string[], start: number): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
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
  const urls = await resolveUrls(id, q, lang);
  const headers = { "content-type": "video/mp4", "cache-control": "no-store", "accept-ranges": "none" };
  if (req.method === "HEAD") return void res.writeHead(200, headers).end();

  const ff = spawn("ffmpeg", ffmpegArgs(urls, start), { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  ff.stderr.on("data", (d) => (stderr = (stderr + d).slice(-500)));
  res.on("close", () => ff.kill("SIGKILL")); // viewer left or seeked: stop pulling from Google

  let started = false;
  ff.stdout.on("data", (chunk: Buffer) => {
    if (!started) {
      started = true;
      res.writeHead(200, headers);
    }
    if (!res.write(chunk)) {
      ff.stdout.pause();
      res.once("drain", () => ff.stdout.resume());
    }
  });
  await new Promise<void>((resolve) => {
    ff.on("close", (code, signal) => {
      if (!started) {
        console.error(`ffmpeg ${id}: exit ${code ?? signal}: ${stderr.trim()}`);
        res.writeHead(502, { "content-type": "text/plain" }).end("could not stream video");
      } else res.end();
      resolve();
    });
  });
}
