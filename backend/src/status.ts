import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getDb, pingDb, stmt } from "./db.ts";

const run = promisify(execFile);

/** Consecutive failed resolves (with no success since) after which the instance counts as "failing". */
export const FAILING_AFTER = 3;
const VERSION_TTL_MS = 60 * 60_000;
const KEY_OK = "status.lastOk";
const KEY_FAIL = "status.lastFail";

export type FailReason = "bot-check" | "rate-limited" | "unavailable" | "timeout" | "network" | "not-installed" | "no-url" | "other";
export interface LastOk { at: number }
export interface LastFail { at: number; reason: FailReason; consecutive: number }

const started = Date.now();
let ok = 0;
let failed = 0;
let lastOk: LastOk | null = null;
let lastFail: LastFail | null = null;
let loaded = false;

/**
 * Short classification of a failed yt-dlp run. Only a fixed label ever leaves this function: yt-dlp's own text
 * contains the watch URL and sometimes paths, so it is never stored or returned.
 */
export function classifyFailure(err: unknown): FailReason {
  const e = err as { code?: unknown; killed?: boolean; message?: string; stderr?: string };
  if (e?.code === "ENOENT") return "not-installed";
  if (e?.killed) return "timeout";
  const t = `${e?.stderr ?? ""}\n${e?.message ?? ""}`.toLowerCase();
  if (t.includes("returned no stream url")) return "no-url";
  // Keep these patterns in step with scripts/smoke-ytdlp.sh (it separates "YouTube blocked this runner" from a real regression).
  if (/confirm your age|age.restricted|inappropriate for some users/.test(t)) return "unavailable"; // before bot-check: "Sign in to confirm your age"
  if (/confirm you.re not a bot/.test(t)) return "bot-check";
  if (/http error 429|too many requests|rate.?limit/.test(t)) return "rate-limited";
  if (/video unavailable|private video|has been removed|not available|members.only|live event/.test(t)) return "unavailable";
  if (/unable to download|timed out|name or service not known|temporary failure|connection (refused|reset)|network is unreachable|getaddrinfo/.test(t)) return "network";
  return "other";
}

function persist(key: string, value: unknown): void {
  try {
    stmt(getDb(), "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, JSON.stringify(value));
  } catch (e) {
    console.error(`status: could not persist ${key}: ${(e as Error).message}`);
  }
}

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const get = (k: string) => stmt(getDb(), "SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined;
    const o = get(KEY_OK);
    const f = get(KEY_FAIL);
    if (o) lastOk = JSON.parse(o.value) as LastOk;
    if (f) lastFail = JSON.parse(f.value) as LastFail;
  } catch (e) {
    console.error(`status: could not load persisted state: ${(e as Error).message}`);
  }
}

/** Wraps one real yt-dlp resolve (not cache hits) and records its outcome. Never changes the result or the error. */
export async function tracked<T>(fn: () => Promise<T>): Promise<T> {
  load();
  try {
    const r = await fn();
    ok++;
    lastOk = { at: Date.now() };
    persist(KEY_OK, lastOk);
    return r;
  } catch (e) {
    failed++;
    const reason = classifyFailure(e);
    // A private, removed, age-restricted... video is the viewer's problem, not yt-dlp's: counted and shown as the
    // last failure, but it neither extends nor resets a streak, so it can never make the instance look broken.
    const consecutive = reason === "unavailable" ? openFailures() : openFailures() + 1;
    lastFail = { at: Date.now(), reason, consecutive };
    persist(KEY_FAIL, lastFail);
    throw e;
  }
}

/** Test seam: forget the in-memory state so the next call reloads what was persisted (a simulated restart). */
export function resetStatusForTests(): void {
  ok = failed = 0;
  lastOk = lastFail = null;
  loaded = false;
  versions.clear();
}

const versions = new Map<string, { at: number; value: string | null; pending?: Promise<void> }>();

/** First line of `<bin> <arg>` with the version token extracted; null if the tool is missing or fails. */
async function probe(name: string, bin: string, arg: string, pick: (out: string) => string | null): Promise<string | null> {
  const hit = versions.get(name);
  const fresh = hit && Date.now() - hit.at < VERSION_TTL_MS;
  if (fresh) return hit.value;
  const refresh = async () => {
    let value: string | null = null;
    try {
      const { stdout } = await run(bin, [arg], { timeout: 10_000 });
      value = pick(stdout);
    } catch {
      value = null;
    }
    versions.set(name, { at: Date.now(), value });
  };
  if (hit) {
    // Stale: answer with what we have and refresh in the background.
    hit.pending ??= refresh().finally(() => void (versions.get(name)!.pending = undefined));
    return hit.value;
  }
  await refresh();
  return versions.get(name)!.value;
}

export const ytdlpVersion = () => probe("yt-dlp", process.env.YTDLP_BIN ?? "yt-dlp", "--version", (o) => o.trim().split("\n")[0].slice(0, 40) || null);
export const ffmpegVersion = () =>
  probe("ffmpeg", process.env.FFMPEG_BIN ?? "ffmpeg", "-version", (o) => /^ffmpeg version (\S+)/m.exec(o)?.[1].slice(0, 60) ?? null);

/** Failed resolves since the last success (0 if the latest outcome was a success). */
const openFailures = (): number => (lastFail && (!lastOk || lastFail.at > lastOk.at) ? lastFail.consecutive : 0);

export function health(): "ok" | "degraded" | "failing" {
  const n = openFailures();
  return n >= FAILING_AFTER ? "failing" : n > 0 ? "degraded" : "ok";
}

const iso = (ms: number) => new Date(ms).toISOString();

function cacheStatus(): { ok: boolean; entries: number; bytes: number } {
  try {
    pingDb();
    const r = stmt(getDb(), "SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS b FROM cache").get() as { n: number; b: number };
    return { ok: true, entries: Number(r.n), bytes: Number(r.b) };
  } catch {
    return { ok: false, entries: 0, bytes: 0 };
  }
}

/** Everything /api/status returns. No secrets, URLs or paths. */
export async function statusReport() {
  load();
  const [yt, ff] = await Promise.all([ytdlpVersion(), ffmpegVersion()]);
  const db = cacheStatus();
  let h = health();
  if (h === "ok" && (yt === null || !db.ok)) h = "degraded"; // can't run yt-dlp, or storage is broken
  return {
    health: h,
    ytdlp: { version: yt, present: yt !== null },
    resolves: {
      ok,
      failed,
      consecutiveFailures: openFailures(),
      lastSuccess: lastOk ? { at: iso(lastOk.at) } : null,
      lastFailure: lastFail ? { at: iso(lastFail.at), reason: lastFail.reason } : null,
    },
    ffmpeg: { present: ff !== null, version: ff },
    node: process.version,
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    cache: db,
  };
}

const rows = (o: object, prefix = ""): string[] =>
  Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? rows(v, `${prefix}${k}.`) : [`${prefix}${k}: ${v}`]));
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The /status page: the same data as /api/status, one "a.b: value" line per field, styled by the shared stylesheet. */
export function statusPage(report: object): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status - YouTube Classic</title>
<link rel="stylesheet" href="/static/classic.css">
<link rel="icon" href="/static/img/favicon.svg" type="image/svg+xml">
</head>
<body>
<div id="masthead"><a id="logo" href="/">You<span>Tube</span></a></div>
<div id="page">
<h2>Status</h2>
<pre id="report">${esc(rows(report).join("\n"))}</pre>
</div>
</body>
</html>
`;
}
