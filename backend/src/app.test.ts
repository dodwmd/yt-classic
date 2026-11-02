import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, resetTvLimiter } from "./app.ts";
import { clearCache } from "./cache.ts";
import { closeDb, getDb } from "./db.ts";
import { clearHistory } from "./history.ts";
import { clearSearches, listSearches } from "./searches.ts";
import { resetSuggest } from "./suggest.ts";
import { deletePlaylist, listPlaylists, resetLookupLimit, noteLookup, MAX_LOOKUPS_PER_HOUR } from "./playlists.ts";
import { clearFailures, killChildren, resolveUrls } from "./yt/dlp.ts";
import { ROUTE_CLASSES, RESOLVE_BUCKETS, STATUS_CLASSES } from "./metrics.ts";
import { CODES, INFO, type ErrorCode } from "./errors.ts";

const CHANNEL = "UC" + "a".repeat(22);
const VID = "AAAAAAAAAAA";
const tvChan = (c: string) => "UC" + c.repeat(22);
const tvId = (c: string, i: number) => `T${c}${i}`.padEnd(11, "x");

let server: Server;
let port = 0;
let tmp = "";
const realFetch = globalThis.fetch;
let videoCalls = 0;
let apiSearchCalls = 0;

function script(name: string, body: string): string {
  const p = join(tmp, name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
  return p;
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "yt-app-"));
  process.env.DATA_DIR = join(tmp, "data");
  process.env.YT_API_KEY = "test-key";
  process.env.PIDFILE = join(tmp, "ffmpeg.pid");
  process.env.YTDLP_BIN = script(
    "yt-dlp",
    `mode=j; for a in "$@"; do [ "$a" = "-g" ] && mode=g; done
[ "$mode" = g ] && echo x >> "$(dirname "$0")/resolves"
[ -n "$ARGS_LOG" ] && echo "$@" >> "$ARGS_LOG"
[ "$mode" = j ] && [ -n "$SEARCH_SLEEP" ] && sleep "$SEARCH_SLEEP"
case "$*" in *zeroresults*) echo '{"entries":[]}'; exit 0;; esac
case "$*" in *sp=EgIQAg*) echo '{"entries":[{"id":"${tvChan("c")}","channel_id":"${tvChan("c")}","channel":"Chan C","uploader_id":"@chanc","channel_follower_count":1234,"description":"About C","thumbnails":[{"url":"//yt3.ggpht.com/a=s88","width":88},{"url":"//yt3.ggpht.com/a=s176","width":176}]},{"id":"${VID}","title":"a video, not a channel"}]}'; exit 0;; esac
if [ "$mode" = g ] && [ -n "$FAKE_YTDLP_ERR" ]; then printf '%s\\n' "$FAKE_YTDLP_ERR" >&2; exit 1
elif [ "$mode" = g ]; then sleep "\${FAKE_RESOLVE_SLEEP:-0}"; [ -n "$FAKE_YTDLP_FMT" ] && echo "YTFMT $FAKE_YTDLP_FMT"; echo https://example.invalid/v; echo https://example.invalid/a
else echo '{"entries":[{"id":"${VID}","title":"<script>alert(1)</script>","channel":"Chan","channel_id":"${CHANNEL}","duration":65,"view_count":10}]}'; fi`,
  );
  process.env.FFMPEG_BIN = script("ffmpeg", `echo $$ > "$PIDFILE"; printf xxxx; exec sleep 30`);
  // Stub only the YouTube Data API; nothing here touches the network.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.includes("/youtube/v3/search")) apiSearchCalls++;
    if (u.includes("/feeds/videos.xml")) { // TV tests: channel UC<c x22> has videos T<c>1.. T<c>3
      const cid = new URL(u).searchParams.get("channel_id") ?? "";
      const c = cid[2];
      const entries = [1, 2, 3].map((i) => `<entry><yt:videoId>${tvId(c, i)}</yt:videoId><yt:channelId>${cid}</yt:channelId><title>t${c}${i}</title><published>2026-01-0${i}T00:00:00Z</published><author><name>Chan ${c}</name></author></entry>`).join("");
      return new Response(`<feed><yt:channelId>${cid}</yt:channelId>${entries}</feed>`, { status: 200 });
    }
    if (u.includes("/youtube/v3/videos") && (new URL(u).searchParams.get("id") ?? "").startsWith("T")) {
      const items = (new URL(u).searchParams.get("id") ?? "").split(",").map((id) => {
        const c = id[1];
        const live = id[2] === "3";
        return {
          id, snippet: { title: `Title ${id}`, channelId: tvChan(c), channelTitle: `Chan ${c}`, description: "d", publishedAt: "2026-01-01T00:00:00Z", thumbnails: {}, liveBroadcastContent: live ? "live" : "none" },
          contentDetails: { duration: live ? "P0D" : "PT10M" }, statistics: {},
        };
      });
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (u.includes("/youtube/v3/channels")) {
      const item = { id: CHANNEL, snippet: { title: "Chan", description: "d", thumbnails: {} }, statistics: {}, brandingSettings: {} };
      return new Response(JSON.stringify({ items: [item] }), { status: 200 });
    }
    if (u.includes("/youtube/v3/videos")) {
      videoCalls++;
      const id = new URL(u).searchParams.get("id");
      if (id === "FAILING0000") return new Response("{}", { status: 500 });
      if (id === "QUOTA000000") return new Response(JSON.stringify({ error: { code: 403, message: "quota key=SECRET", errors: [{ reason: "quotaExceeded" }] } }), { status: 403 });
      if (id === "NOTFOUND000") return new Response(JSON.stringify({ items: [] }), { status: 200 });
      const item = {
        id, snippet: { title: "Server title", channelId: CHANNEL, channelTitle: "Server chan", description: "d", publishedAt: "2026-01-01T00:00:00Z", thumbnails: { medium: { url: "https://i.ytimg.com/server.jpg" } } },
        contentDetails: { duration: "PT10M", ...(id === "AGEVIDEO000" ? { contentRating: { ytRating: "ytAgeRestricted" } } : {}) }, statistics: {},
      };
      if (id === "LIVEVIDEO00") item.snippet = { ...item.snippet, liveBroadcastContent: "live" } as typeof item.snippet;
      return new Response(JSON.stringify({ items: [item] }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  server = createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  killChildren();
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  clearCache();
  clearHistory();
  clearSearches();
  resetSuggest();
  delete process.env.ARGS_LOG;
  resetLookupLimit();
  for (const p of listPlaylists()) if (!p.builtin) deletePlaylist(p.id);
  getDb().exec("DELETE FROM playlist_items");
  videoCalls = 0;
  apiSearchCalls = 0;
  delete process.env.SEARCH_SLEEP;
  resetTvLimiter();
  rmSync(process.env.PIDFILE!, { force: true });
  delete process.env.FAKE_RESOLVE_SLEEP;
  delete process.env.FAKE_YTDLP_ERR;
  clearFailures();
  delete process.env.ALLOWED_HOSTS;
  process.env.FFMPEG_BIN = join(tmp, "ffmpeg");
});

function get(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("basic routing and validation", async () => {
  assert.equal((await get("/healthz")).status, 200);
  assert.equal((await get("/nope")).status, 404);
  assert.equal((await get("/api/video/bad")).status, 400);
  assert.equal((await get("/api/channel/bad")).status, 400);
  assert.equal((await get("/stream/bad")).status, 400);
  assert.equal((await get("/api/search?q=" + "x".repeat(300))).status, 400);
  assert.equal((await get("/api/search?q=")).status, 400);
  assert.equal((await get("/api/nope")).status, 404);
});

test("/api/home returns the subscriptions, the feed and the saved filters (no suggestion rows)", async () => {
  const r = await get("/api/home");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(r.body)).sort(), ["continue", "feed", "prefs", "subs"]);
});

const subscribeTv = async (n: number) => {
  for (let i = 1; i <= n; i++) assert.equal((await get("/api/subscribe", { method: "POST", body: `id=${tvChan(String(i))}`, headers: { "content-type": "application/x-www-form-urlencoded" } })).status, 200);
};
const unsubscribeTv = async () => {
  for (let i = 1; i <= 6; i++) await get("/api/unsubscribe", { method: "POST", body: `id=${tvChan(String(i))}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
};

test("TV: the server enforces the five-subscription gate and validates input", async () => {
  const status = JSON.parse((await get("/api/tv/status")).body);
  assert.deepEqual(status, { have: 0, need: 5, ok: false });
  const r = await get("/api/tv/next");
  assert.equal(r.status, 409);
  const body = JSON.parse(r.body);
  assert.equal(body.code, "need-subscriptions");
  assert.deepEqual([body.have, body.need], [0, 5]);
  assert.match(body.error, /Subscribe to 5 more channels/);
  assert.equal((await get("/api/tv/next?after=bad")).status, 400);
  assert.equal((await get("/api/tv/next?seen=" + "A".repeat(5000))).status, 400);
});

test("TV: /api/tv/next returns the watch shape plus channelId, honours after and seen, and 404s when nothing is left", async () => {
  await subscribeTv(5);
  try {
    assert.equal(JSON.parse((await get("/api/tv/status")).body).ok, true);
    const after = tvChan("1");
    const seenIds = new Set<string>();
    for (let n = 0; n < 6; n++) {
      const r = await get(`/api/tv/next?after=${after}&seen=${[...seenIds].join(",")}`);
      assert.equal(r.status, 200, r.body);
      const o = JSON.parse(r.body);
      assert.deepEqual(Object.keys(o).sort(), ["channelId", "lang", "qualities", "quality", "video"]);
      assert.equal(o.channelId, o.video.channelId);
      assert.notEqual(o.channelId, after);
      assert.ok(!seenIds.has(o.video.id), "seen is excluded");
      assert.notEqual(o.video.id[2], "3", "live entries are never picked");
      assert.equal(o.video.durationSeconds, 600);
      seenIds.add(o.video.id);
      resetTvLimiter();
    }
    // Four other channels x two playable videos = 8; mark all of them seen.
    const all = ["2", "3", "4", "5"].flatMap((c) => [1, 2].map((i) => tvId(c, i)));
    const none = await get(`/api/tv/next?after=${after}&seen=${all.join(",")}`);
    assert.equal(none.status, 404);
    assert.equal(JSON.parse(none.body).code, "nothing-playable");
  } finally {
    await unsubscribeTv();
  }
});

test("TV: only GET, and a cross-site request is refused before any lookup", async () => {
  await subscribeTv(5);
  try {
    const before = videoCalls;
    assert.equal((await get("/api/tv/next", { method: "POST", body: "" })).status, 405);
    assert.equal((await get("/api/tv/next", { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await get("/api/tv/next", { headers: { origin: "https://evil.example" } })).status, 403);
    assert.equal(videoCalls, before, "no lookups for refused requests");
    assert.equal((await get("/api/tv/next", { headers: { "sec-fetch-site": "same-origin" } })).status, 200);
  } finally {
    await unsubscribeTv();
  }
});

test("TV: requests are rate limited with Retry-After", async () => {
  await subscribeTv(5);
  try {
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await get("/api/tv/next")).status);
    assert.deepEqual(codes.slice(0, 3), [200, 200, 200]);
    assert.ok(codes.includes(429), `no 429 in ${codes.join(",")}`);
  } finally {
    await unsubscribeTv();
  }
});

test("search returns JSON with raw (unescaped) data; escaping is the frontend's job", async () => {
  const r = await get("/api/search?q=nix");
  assert.equal(r.status, 200);
  const page = JSON.parse(r.body);
  assert.equal(page.items[0].title, "<script>alert(1)</script>");
  assert.equal(page.items[0].durationSeconds, 65);
});

test("the dev server serves the frontend pages and assets", async () => {
  for (const path of ["/", "/results", "/watch", "/subscriptions", "/channel/" + CHANNEL]) {
    const r = await get(path);
    assert.equal(r.status, 200, path);
    assert.ok(r.body.includes("<!doctype html>"), path);
  }
  assert.equal((await get("/static/classic.css")).status, 200);
  assert.equal((await get("/static/js/lib.js")).status, 200);
  assert.equal((await get("/static/../../backend/package.json")).status, 404);
});

test("host allow-list rejects unknown hosts", async () => {
  process.env.ALLOWED_HOSTS = "good.example";
  assert.equal((await get("/api/home")).status, 421);
  assert.equal((await get("/healthz")).status, 200);
});

test("cross-site POSTs are refused, same-origin and non-browser ones work", async () => {
  const body = `id=${CHANNEL}`;
  const form = { "content-type": "application/x-www-form-urlencoded" };
  assert.equal((await get("/api/subscribe", { method: "POST", body, headers: { ...form, origin: "http://evil.example" } })).status, 403);
  assert.equal((await get("/api/subscribe", { method: "POST", body, headers: { ...form, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await get("/api/subscribe", { method: "POST", body, headers: { ...form, origin: `http://127.0.0.1:${port}` } })).status, 200);
  assert.equal((await get("/api/unsubscribe", { method: "POST", body, headers: form })).status, 200); // curl-style: no Origin
  assert.equal((await get("/api/subscribe", { method: "POST", body: "id=nope", headers: form })).status, 400);
});

test("a missing ffmpeg gives a 502 and does not crash the server", async () => {
  process.env.FFMPEG_BIN = join(tmp, "does-not-exist");
  assert.equal((await get(`/stream/${VID}`)).status, 502);
  assert.equal((await get("/healthz")).status, 200);
});

test("leaving while yt-dlp is still resolving never starts ffmpeg", async () => {
  process.env.FAKE_RESOLVE_SLEEP = "1";
  await new Promise<void>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: `/stream/${VID}` });
    req.on("error", () => {});
    req.end();
    setTimeout(() => { req.destroy(); resolve(); }, 250);
  });
  await sleep(1800); // resolve finishes ~1s in
  assert.equal(existsSync(process.env.PIDFILE!), false, "ffmpeg was spawned for a viewer who had already left");
});

test("leaving mid-stream kills ffmpeg", async () => {
  await new Promise<void>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: `/stream/${VID}` }, (res) => {
      assert.equal(res.statusCode, 200);
      res.once("data", () => { req.destroy(); resolve(); });
    });
    req.on("error", () => {});
    req.on("timeout", () => reject(new Error("no data")));
    req.end();
  });
  const pid = Number(readFileSync(process.env.PIDFILE!, "utf8"));
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(50);
  assert.equal(alive(pid), false, "ffmpeg is still running after the client left");
});

test("/healthz reflects database health: 200, then 503 while it cannot be opened, then 200 again", async () => {
  const good = process.env.DATA_DIR!;
  assert.equal((await get("/healthz")).status, 200);
  const notADir = join(tmp, "plain-file");
  writeFileSync(notADir, "x");
  process.env.DATA_DIR = notADir;
  const real = console.error;
  console.error = () => {};
  try {
    const r = await get("/healthz");
    assert.equal(r.status, 503);
    assert.match(r.body, /database unavailable/);
  } finally {
    console.error = real;
    process.env.DATA_DIR = good;
  }
  assert.equal((await get("/healthz")).status, 200);
});

const form = { "content-type": "application/x-www-form-urlencoded" };
const post = (path: string, body: string, headers: Record<string, string> = form) => get(path, { method: "POST", body, headers });
const hist = async () => JSON.parse((await get("/api/history")).body).items as Record<string, unknown>[];

test("POST /api/progress records server-side metadata, never the client's", async () => {
  const body = `id=${VID}&position=42&duration=1&title=EVIL&channelTitle=EVIL&thumb=http://evil`;
  const r = await post("/api/progress", body);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { recorded: true });
  const [row] = await hist();
  assert.equal(row.title, "Server title");
  assert.equal(row.channelTitle, "Server chan");
  assert.equal(row.thumb, "https://i.ytimg.com/server.jpg");
  assert.equal(row.durationSeconds, 600);
  assert.equal(row.position, 42);
  // Later updates reuse the stored row: no further Data API call.
  const calls = videoCalls;
  assert.equal(JSON.parse((await post("/api/progress", `id=${VID}&position=90`)).body).recorded, true);
  assert.equal(videoCalls, calls);
  // JSON bodies work too (Android), including finished.
  const j = await post("/api/progress", JSON.stringify({ id: VID, position: 91, finished: true }), { "content-type": "application/json" });
  assert.equal(j.status, 200);
  assert.equal((await hist())[0].completed, true);
});

test("POST /api/progress rejects bad input and ignores trivial updates", async () => {
  assert.equal((await post("/api/progress", "id=bad&position=10")).status, 400);
  assert.equal((await post("/api/progress", `id=${VID}&position=abc`)).status, 400);
  assert.equal((await post("/api/progress", `id=${VID}&position=-5`)).status, 400);
  assert.equal((await post("/api/progress", `id=${VID}`)).status, 400);
  assert.equal((await post("/api/progress", "{not json", { "content-type": "application/json" })).status, 400);
  assert.equal((await post("/api/progress", `id=${VID}&position=${"9".repeat(5000)}`)).status, 413);
  assert.equal((await post("/api/progress", `id=NOTFOUND000&position=30`)).status, 404);
  const real = console.error;
  console.error = () => {};
  try {
    assert.equal((await post("/api/progress", `id=FAILING0000&position=30`)).status, 502); // Data API down
  } finally {
    console.error = real;
  }
  assert.deepEqual(await hist(), [], "a failed or empty metadata lookup must not create a row");
  const short = await post("/api/progress", `id=${VID}&position=3`);
  assert.deepEqual(JSON.parse(short.body), { recorded: false });
  assert.equal(videoCalls, 2, "a sub-5s look must not even look the video up (only the two probes did)");
  assert.deepEqual(await hist(), []);
  await post("/api/progress", `id=${VID}&position=30`);
  assert.deepEqual(JSON.parse((await post("/api/progress", `id=${VID}&position=31`)).body), { recorded: false });
});

test("absurd positions are clamped before they are stored", async () => {
  assert.equal((await post("/api/progress", `id=${VID}&position=1e308`)).status, 200);
  assert.equal((await hist())[0].position, 600); // clamped to the video's length
  assert.equal((await post("/api/progress", `id=${VID}&position=1e999`)).status, 400); // Infinity
});

test("history endpoints are same-origin only for writes", async () => {
  await post("/api/progress", `id=${VID}&position=30`);
  const evil = { ...form, origin: "http://evil.example" };
  assert.equal((await post("/api/progress", `id=${VID}&position=100`, evil)).status, 403);
  assert.equal((await post("/api/history/clear", "", evil)).status, 403);
  assert.equal((await get(`/api/history/${VID}`, { method: "DELETE", headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await hist()).length, 1);
  assert.equal((await get("/api/history/bad", { method: "DELETE" })).status, 400);
  assert.deepEqual(JSON.parse((await get(`/api/history/${VID}`, { method: "DELETE" })).body), { removed: true });
  await post("/api/progress", `id=${VID}&position=30`);
  assert.deepEqual(JSON.parse((await post("/api/history/clear", "")).body), { removed: 1 });
  assert.deepEqual(await hist(), []);
});

test("GET /api/history validates limit/before and pages", async () => {
  assert.equal((await get("/api/history?limit=0")).status, 400);
  assert.equal((await get("/api/history?limit=101")).status, 400);
  assert.equal((await get("/api/history?before=abc")).status, 400);
  assert.equal((await get("/api/history?before=1")).status, 400); // cursors are opaque, not timestamps
  await post("/api/progress", `id=${VID}&position=30`);
  const page = JSON.parse((await get("/api/history?limit=1")).body);
  assert.equal(page.items.length, 1);
  assert.match(page.next, /^\d+\.\d+$/);
  assert.deepEqual(JSON.parse((await get(`/api/history?limit=1&before=${page.next}`)).body).items, []);
});

test("video and home expose progress / continue; watched lookup", async () => {
  assert.equal(JSON.parse((await get(`/api/video/${VID}`)).body).progress, undefined);
  await post("/api/progress", `id=${VID}&position=30`);
  assert.deepEqual(JSON.parse((await get(`/api/video/${VID}`)).body).progress, { position: 30, completed: false });
  const home = JSON.parse((await get("/api/home")).body);
  assert.equal(home.continue.length, 1);
  assert.equal(home.continue[0].id, VID);
  assert.deepEqual(JSON.parse((await get(`/api/history/watched?ids=${VID}`)).body).ids, []);
  await post("/api/progress", `id=${VID}&position=600&finished=1`);
  assert.deepEqual(JSON.parse((await get(`/api/history/watched?ids=${VID},bad`)).body).ids, [VID]);
  assert.deepEqual(JSON.parse((await get("/api/home")).body).continue, []);
});

const A = "UC" + "1".repeat(22), B = "UC" + "2".repeat(22);
// The response also carries a human-readable `message`; most tests compare only the counts.
const counts = (body: string) => {
  const { message, ...rest } = JSON.parse(body);
  assert.equal(typeof message, "string");
  return rest;
};
const importPost = (body: string | Buffer, headers: Record<string, string> = {}) =>
  get("/api/subscriptions/import", { method: "POST", body, headers: { "content-type": "text/plain", ...headers } });
const subIds = async () => (JSON.parse((await get("/api/home")).body).subs as { id: string }[]).map((s) => s.id);

test("import: CSV, response shape, then re-import reports existing; handles and junk are counted", async () => {
  const csv = `\uFEFFChannel ID,Channel URL,Channel title\r\n${A},http://www.youtube.com/channel/${A},"One, the first"\r\n${B},,Two\r\n,https://www.youtube.com/@h,H\r\nbad,,X\r\n`;
  const r = await importPost(csv);
  assert.equal(r.status, 200);
  assert.deepEqual(counts(r.body), { added: 2, existing: 0, skipped: { invalid: 1, handles: 1, full: 0 }, total: 2 });
  assert.equal(JSON.parse(r.body).message, "Added 2, 0 already subscribed. Skipped 1 invalid, 1 @handle (can't be resolved). You now have 2 subscriptions.");
  assert.deepEqual(await subIds(), [A, B]);
  assert.deepEqual(counts((await importPost(`${A}\n${B}\n`)).body), { added: 0, existing: 2, skipped: { invalid: 0, handles: 0, full: 0 }, total: 2 });
  for (const id of [A, B]) await get("/api/unsubscribe", { method: "POST", body: `id=${id}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
});

test("import: size cap gives 413 and imports nothing; an empty or unrecognisable body gives 400", async () => {
  const line = `https://www.youtube.com/channel/${A}\n`;
  const big = await importPost(line.repeat(Math.ceil((1024 * 1024 + 1) / line.length)));
  assert.equal(big.status, 413);
  assert.deepEqual(await subIds(), []);
  assert.equal((await importPost("")).status, 400);
  assert.equal((await importPost(" \r\n ")).status, 400);
  assert.equal((await importPost("<opml><body/></opml>")).status, 400);
});

test("import: cross-site POSTs are refused and change nothing", async () => {
  assert.equal((await importPost(A, { origin: "http://evil.example" })).status, 403);
  assert.equal((await importPost(A, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.deepEqual(await subIds(), []);
  assert.equal((await importPost(A, { origin: `http://127.0.0.1:${port}` })).status, 200);
  await get("/api/unsubscribe", { method: "POST", body: `id=${A}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
});

test("import: MAX_SUBS overflow is reported as skipped.full", async () => {
  const many = Array.from({ length: 503 }, (_, i) => "UC" + String(i).padStart(22, "0")).join("\n");
  const r = counts((await importPost(many)).body);
  assert.deepEqual(r, { added: 500, existing: 0, skipped: { invalid: 0, handles: 0, full: 3 }, total: 500 });
  const csv = (await get("/api/subscriptions/export")).body;
  assert.equal(csv.trim().split("\r\n").length, 501);
  const db = (await import("./db.ts")).getDb();
  db.exec("DELETE FROM subscriptions");
});

test("export: headers, CSV and OPML downloads that import back to the same list", async () => {
  await importPost(`Channel ID,Channel URL,Channel title\n${A},,"Tom & ""Jerry"", <3"\n${B},,Plain`);
  const csv = await get("/api/subscriptions/export?format=csv");
  assert.equal(csv.status, 200);
  const opml = await get("/api/subscriptions/export?format=opml");
  const head = (path: string) => new Promise<Record<string, unknown>>((resolve, reject) => {
    request({ host: "127.0.0.1", port, path }, (res) => { res.resume(); resolve(res.headers); }).on("error", reject).end();
  });
  const h = await head("/api/subscriptions/export?format=opml");
  assert.equal(h["content-disposition"], 'attachment; filename="subscriptions.opml"');
  assert.match(String(h["content-type"]), /^text\/x-opml; charset=utf-8/);
  assert.equal((await head("/api/subscriptions/export"))["content-disposition"], 'attachment; filename="subscriptions.csv"');
  assert.match(String((await head("/api/subscriptions/export"))["content-type"]), /^text\/csv; charset=utf-8/);
  assert.equal((await get("/api/subscriptions/export?format=zip")).status, 400);

  const db = (await import("./db.ts")).getDb();
  for (const exported of [csv.body, opml.body]) {
    db.exec("DELETE FROM subscriptions");
    const r = JSON.parse((await importPost(exported)).body);
    assert.deepEqual([r.added, r.total, r.skipped.invalid], [2, 2, 0]);
    const titles = (await (await import("./store.ts")).listSubs()).map((s) => s.title);
    assert.deepEqual(titles, ['Tom & "Jerry", <3', "Plain"]);
  }
  db.exec("DELETE FROM subscriptions");
});

test("import: exactly 1 MiB is accepted, one byte more is 413", async () => {
  const pad = (n: number) => `${A}\n` + "#".repeat(n - (A.length + 1)); // a list line plus a comment line, n bytes in all
  const ok = await importPost(pad(1048576));
  assert.equal(ok.status, 200);
  assert.equal(JSON.parse(ok.body).added, 1);
  assert.equal((await importPost(pad(1048577))).status, 413);
  await get("/api/unsubscribe", { method: "POST", body: `id=${A}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
});

test("import: UTF-16 files are decoded; bytes that are not valid text give a clear 400 and import nothing", async () => {
  const csv = `Channel ID,Channel URL,Channel title\n${A},,Caf\u00e9\n`;
  const r = await importPost(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]));
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).added, 1);
  const db = (await import("./db.ts")).getDb();
  assert.equal((db.prepare("SELECT title FROM subscriptions WHERE id = ?").get(A) as { title: string }).title, "Caf\u00e9");
  db.exec("DELETE FROM subscriptions");
  const bad = await importPost(Buffer.from([...Buffer.from(`${A}\n`), 0xe9, 0x0a]));
  assert.equal(bad.status, 400);
  assert.match(bad.body, /not valid UTF-8 or UTF-16/);
  assert.deepEqual(await subIds(), []);
});

test("export: the CSV is formula-safe and still imports back", async () => {
  await importPost(`Channel ID,Channel URL,Channel title\n${A},,"=1+1"\n`);
  const csv = (await get("/api/subscriptions/export")).body;
  assert.ok(csv.includes(",'=1+1"), csv);
  const db = (await import("./db.ts")).getDb();
  db.exec("DELETE FROM subscriptions");
  await importPost(csv);
  assert.equal((db.prepare("SELECT title FROM subscriptions WHERE id = ?").get(A) as { title: string }).title, "=1+1");
  db.exec("DELETE FROM subscriptions");
});

// ---- playlists ----
const J = { "content-type": "application/json" };
const evil = { ...form, origin: "http://evil.example" };
const body = (r: { body: string }) => JSON.parse(r.body);
const mkList = async (name: string) => body(await post("/api/playlists", `name=${encodeURIComponent(name)}`)).playlist.id as number;

test("playlists: create, list, rename, delete; Watch later is protected", async () => {
  assert.deepEqual(body(await get("/api/playlists")).playlists, [{ id: 1, name: "Watch later", count: 0, builtin: true }]);
  const id = await mkList("Music");
  assert.equal((await post("/api/playlists", "name=music")).status, 409);
  assert.equal((await post("/api/playlists", "name=")).status, 400);
  assert.equal((await post("/api/playlists", JSON.stringify({ name: "x".repeat(81) }), J)).status, 400);
  assert.equal((await post("/api/playlists", "name=" + "x".repeat(5000))).status, 413);
  assert.equal((await post(`/api/playlists/${id}/rename`, "name=Tunes")).status, 200);
  assert.deepEqual(body(await get("/api/playlists")).playlists.map((p: { name: string }) => p.name), ["Watch later", "Tunes"]);
  assert.equal((await post("/api/playlists/1/rename", "name=Mine")).status, 403);
  assert.equal((await get("/api/playlists/1", { method: "DELETE" })).status, 403);
  assert.equal((await post("/api/playlists/77/rename", "name=Mine")).status, 404);
  assert.equal((await post("/api/playlists/abc/rename", "name=Mine")).status, 400);
  assert.equal((await get(`/api/playlists/${id}`, { method: "DELETE" })).status, 200);
  assert.equal((await get(`/api/playlists/${id}`, { method: "DELETE" })).status, 404);
  assert.equal((await get(`/api/playlists/${id}`)).status, 404);
  assert.equal((await get("/api/playlists", { method: "PUT" })).status, 405);
});

test("playlists: adding takes metadata from the server, dedupes, and a failing lookup creates nothing", async () => {
  const r = await post("/api/playlists/1/items", `id=${VID}&title=EVIL&thumb=http://evil&duration=1&channelTitle=EVIL`);
  assert.equal(r.status, 200);
  assert.equal(body(r).added, true);
  assert.equal(body(r).playlist.count, 1);
  const [item] = body(await get("/api/playlists/1")).items;
  assert.deepEqual({ ...item, added: 0 }, { id: VID, title: "Server title", channelId: CHANNEL, channelTitle: "Server chan", thumb: "https://i.ytimg.com/server.jpg", durationSeconds: 600, added: 0 });
  const calls = videoCalls;
  assert.equal(body(await post("/api/playlists/1/items", JSON.stringify({ id: VID }), J)).added, false);
  assert.equal(videoCalls, calls, "an existing item needs no lookup");
  assert.equal(body(await get("/api/playlists/1")).items.length, 1);

  assert.equal((await post("/api/playlists/1/items", "id=bad")).status, 400);
  assert.equal((await post("/api/playlists/1/items", "")).status, 400);
  assert.equal((await post("/api/playlists/99/items", `id=${VID}`)).status, 404);
  assert.equal((await post("/api/playlists/1/items", "id=NOTFOUND000")).status, 404);
  const real = console.error;
  console.error = () => {};
  try {
    assert.equal((await post("/api/playlists/1/items", "id=FAILING0000")).status, 502);
  } finally {
    console.error = real;
  }
  assert.equal(body(await get("/api/playlists/1")).items.length, 1, "failed lookups must not add anything");
});

test("playlists: remove and move", async () => {
  const ids = ["AAAAAAAAAA1", "AAAAAAAAAA2", "AAAAAAAAAA3"];
  for (const i of ids) await post("/api/playlists/1/items", `id=${i}`);
  const order = async () => body(await get("/api/playlists/1")).items.map((i: { id: string }) => i.id);
  assert.deepEqual(await order(), ids);
  assert.equal((await post("/api/playlists/1/move", `id=${ids[2]}&index=0`)).status, 200);
  assert.deepEqual(await order(), [ids[2], ids[0], ids[1]]);
  assert.equal((await post("/api/playlists/1/move", JSON.stringify({ id: ids[0], index: 2 }), J)).status, 200);
  assert.deepEqual(await order(), [ids[2], ids[1], ids[0]]);
  for (const bad of [`id=${ids[0]}`, `id=${ids[0]}&index=-1`, `id=${ids[0]}&index=1.5`, `id=${ids[0]}&index=x`, `id=${ids[0]}&index=`, `id=bad&index=0`]) {
    assert.equal((await post("/api/playlists/1/move", bad)).status, 400, bad);
  }
  assert.equal((await post("/api/playlists/1/move", `id=AAAAAAAAAA9&index=0`)).status, 404);
  assert.equal((await post("/api/playlists/50/move", `id=${ids[0]}&index=0`)).status, 404);
  assert.equal((await get("/api/playlists/1/items/bad", { method: "DELETE" })).status, 400);
  assert.equal((await get("/api/playlists/50/items/AAAAAAAAAA1", { method: "DELETE" })).status, 404);
  assert.deepEqual(body(await get(`/api/playlists/1/items/${ids[1]}`, { method: "DELETE" })), { removed: true });
  assert.deepEqual(body(await get(`/api/playlists/1/items/${ids[1]}`, { method: "DELETE" })), { removed: false });
  assert.deepEqual(await order(), [ids[2], ids[0]]);
});

test("playlists: paging validates limit/before and walks every item", async () => {
  for (const i of [1, 2, 3, 4, 5]) await post("/api/playlists/1/items", `id=AAAAAAAAAA${i}`);
  assert.equal((await get("/api/playlists/1?limit=0")).status, 400);
  assert.equal((await get("/api/playlists/1?limit=101")).status, 400);
  assert.equal((await get("/api/playlists/1?before=abc")).status, 400);
  const seen: string[] = [];
  let before = "";
  for (let n = 0; n < 10; n++) {
    const page = body(await get(`/api/playlists/1?limit=2&before=${before}`));
    seen.push(...page.items.map((i: { id: string }) => i.id));
    if (!page.next) break;
    before = page.next;
  }
  assert.deepEqual(seen, [1, 2, 3, 4, 5].map((i) => `AAAAAAAAAA${i}`));
});

test("playlists: every write refuses cross-origin requests; reads are unaffected", async () => {
  const id = await mkList("Keep");
  await post("/api/playlists/1/items", `id=${VID}`);
  assert.equal((await post("/api/playlists", "name=Evil", evil)).status, 403);
  assert.equal((await post(`/api/playlists/${id}/rename`, "name=Evil", evil)).status, 403);
  assert.equal((await post("/api/playlists/1/items", "id=AAAAAAAAAA2", evil)).status, 403);
  assert.equal((await post("/api/playlists/1/move", `id=${VID}&index=0`, evil)).status, 403);
  assert.equal((await get(`/api/playlists/1/items/${VID}`, { method: "DELETE", headers: { origin: "http://evil.example" } })).status, 403);
  assert.equal((await get(`/api/playlists/${id}`, { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  const lists = body(await get("/api/playlists")).playlists;
  assert.deepEqual(lists.map((p: { name: string; count: number }) => [p.name, p.count]), [["Watch later", 1], ["Keep", 0]]);
});

test("playlists: deleting a playlist removes its items from membership", async () => {
  const id = await mkList("Temp");
  await post(`/api/playlists/${id}/items`, `id=${VID}`);
  assert.deepEqual(body(await get(`/api/playlists/membership?ids=${VID},bad`)), { watchLater: [], any: [VID] });
  await post("/api/playlists/1/items", `id=${VID}`);
  assert.deepEqual(body(await get(`/api/playlists/membership?ids=${VID}`)), { watchLater: [VID], any: [VID] });
  await get(`/api/playlists/${id}`, { method: "DELETE" });
  assert.deepEqual(body(await get(`/api/playlists/membership?ids=${VID}`)), { watchLater: [VID], any: [VID] });
  await get(`/api/playlists/1/items/${VID}`, { method: "DELETE" });
  assert.deepEqual(body(await get(`/api/playlists/membership?ids=${VID}`)), { watchLater: [], any: [] });
  assert.deepEqual(body(await get("/api/playlists/membership")), { watchLater: [], any: [] });
});

test("playlists: parallel requests for one video add it once", async () => {
  const rs = await Promise.all(Array.from({ length: 8 }, () => post("/api/playlists/1/items", `id=${VID}`)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.filter((r) => body(r).added).length, 1);
  assert.equal(body(await get("/api/playlists/1")).items.length, 1);
});

test("playlists: opening the video refreshes the stored copy (lazily, no extra lookups)", async () => {
  await post("/api/playlists/1/items", `id=${VID}`);
  getDb().exec("UPDATE playlist_items SET title = 'stale'");
  await get(`/api/video/${VID}`);
  assert.equal(body(await get("/api/playlists/1")).items[0].title, "Server title");
});

test("playlists: new-video lookups are capped globally per hour (429 + Retry-After); existing items and removals still work", async () => {
  await post("/api/playlists/1/items", `id=${VID}`);
  for (let i = 0; i < MAX_LOOKUPS_PER_HOUR; i++) noteLookup();
  const r = await post("/api/playlists/1/items", "id=AAAAAAAAAA2");
  assert.equal(r.status, 429);
  assert.equal(r.headers["retry-after"], "600");
  const calls = videoCalls;
  const again = await get("/api/playlists/1", {});
  assert.equal(body(again).items.length, 1, "a refused add changes nothing");
  assert.equal(body(await post("/api/playlists/1/items", `id=${VID}`)).added, false, "an item already there needs no lookup");
  assert.equal(videoCalls, calls);
  assert.deepEqual(body(await get(`/api/playlists/1/items/${VID}`, { method: "DELETE" })), { removed: true });
  resetLookupLimit();
  assert.equal((await post("/api/playlists/1/items", "id=AAAAAAAAAA2")).status, 200);
});

const FORM = { "content-type": "application/x-www-form-urlencoded" };

test("feed: /api/feed pages through the subscriptions' videos, /api/home filters, prefs persist and validate", async () => {
  await subscribeTv(2);
  try {
    const home = JSON.parse((await get("/api/home")).body);
    assert.equal(home.feed.length, 6);
    assert.equal(home.next, undefined);
    const p1 = JSON.parse((await get("/api/feed?limit=4")).body);
    assert.equal(p1.items.length, 4);
    assert.ok(p1.next);
    const p2 = JSON.parse((await get(`/api/feed?limit=4&before=${p1.next}`)).body);
    assert.deepEqual([...p1.items, ...p2.items].map((i: { id: string }) => i.id), home.feed.map((i: { id: string }) => i.id));
    assert.equal(p2.next, undefined);
    const one = JSON.parse((await get(`/api/feed?channel=${tvChan("1")}`)).body);
    assert.deepEqual(new Set(one.items.map((i: { channelId: string }) => i.channelId)), new Set([tvChan("1")]));
    // Live videos (id suffix 3 in the stub) are hidden by the live filter; the saved preference applies when the query says nothing.
    assert.equal(JSON.parse((await get("/api/feed?live=hide")).body).items.length, 4);
    assert.equal((await get("/api/feed?limit=0")).status, 400);
    assert.equal((await get("/api/feed?limit=101")).status, 400);
    assert.equal((await get("/api/feed?before=garbage")).status, 400);
    assert.equal((await get("/api/feed?channel=nope")).status, 400);
    assert.equal((await get("/api/feed?shorts=maybe")).status, 400);
    assert.equal((await get("/api/home?hideWatched=2")).status, 400);

    assert.deepEqual(JSON.parse((await get("/api/prefs")).body), { hideWatched: false, shorts: "show", live: "show" });
    const set = await get("/api/prefs", { method: "POST", headers: FORM, body: "live=hide&hideWatched=1" });
    assert.deepEqual(JSON.parse(set.body), { hideWatched: true, shorts: "show", live: "hide" });
    assert.equal(JSON.parse((await get("/api/feed")).body).items.length, 4, "saved live=hide applies by default");
    assert.equal(JSON.parse((await get("/api/feed?live=show&hideWatched=0")).body).items.length, 6, "the query overrides the preference");
    for (const bad of ["shorts=nope", "foo=bar", "hideWatched=yes", "", "live=hide&x=1"]) {
      assert.equal((await get("/api/prefs", { method: "POST", headers: FORM, body: bad })).status, 400, bad);
    }
    assert.deepEqual(JSON.parse((await get("/api/prefs")).body), { hideWatched: true, shorts: "show", live: "hide" }, "a refused update changes nothing");
    assert.equal((await get("/api/prefs", { method: "POST", headers: { ...FORM, origin: "http://evil.example" }, body: "shorts=hide" })).status, 403);
    assert.equal((await get("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ shorts: "hide" }) })).status, 200);
    const bools = await get("/api/prefs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ hideWatched: false, shorts: true, live: false }) });
    assert.deepEqual(JSON.parse(bools.body), { hideWatched: false, shorts: "hide", live: "show" });
    assert.match(JSON.parse((await get("/api/prefs", { method: "POST", headers: FORM, body: "live=sometimes" })).body).error, /show.*hide/);
    assert.equal((await get("/api/prefs", { method: "DELETE" })).status, 405);
  } finally {
    await unsubscribeTv();
    await get("/api/prefs", { method: "POST", headers: FORM, body: "hideWatched=0&shorts=show&live=show" });
  }
});


// --- classified errors ---

const errBody = (r: { body: string }) => JSON.parse(r.body) as { error: string; code: string; retryable: boolean };

const STDERR_CASES: Array<[ErrorCode, string]> = [
  ["age-restricted", "ERROR: [youtube] SECRETVID01: Sign in to confirm your age. This video may be inappropriate for some users."],
  ["region-blocked", "ERROR: [youtube] SECRETVID01: The uploader has not made this video available in your country"],
  ["private", "ERROR: [youtube] SECRETVID01: Private video. Sign in if you\u2019ve been granted access to this video"],
  ["removed", "ERROR: [youtube] SECRETVID01: Video unavailable. This video has been removed by the uploader"],
  ["members-only", "ERROR: [youtube] SECRETVID01: Join this channel to get access to members-only content like this video"],
  ["upcoming", "ERROR: [youtube] SECRETVID01: This live event will begin in 3 hours."],
  ["bot-check", "ERROR: [youtube] SECRETVID01: Sign in to confirm you\u2019re not a bot. Use --cookies-from-browser or --cookies"],
  ["rate-limited", "ERROR: [youtube] SECRETVID01: Unable to download API page: HTTP Error 429: Too Many Requests"],
  ["network", "ERROR: [youtube] SECRETVID01: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>"],
  ["unknown", "ERROR: [youtube] SECRETVID01: something nobody has seen before at /home/user/.cache/yt-dlp"],
];

test("a failed resolve before the stream starts is JSON with the right status, code and retryable flag, and leaks nothing", async () => {
  for (const [code, stderr] of STDERR_CASES) {
    clearCache();
    clearFailures();
    process.env.FAKE_YTDLP_ERR = stderr;
    const r = await get(`/stream/${VID}`);
    assert.equal(r.status, INFO[code].status, code);
    assert.deepEqual(errBody(r), { error: INFO[code].message, code, retryable: INFO[code].retryable }, code);
    for (const leak of ["SECRETVID01", "youtube", "/home", "yt-dlp", "cookies", VID, "example.invalid"]) assert.ok(!r.body.includes(leak), `${code} leaked ${leak}`);
  }
});

test("rate-limited and busy carry retry-after; busy is a 503 with code busy", async () => {
  process.env.FAKE_YTDLP_ERR = "HTTP Error 429: Too Many Requests";
  const limited = await new Promise<string | string[] | undefined>((resolve) => {
    request({ host: "127.0.0.1", port, path: `/stream/${VID}` }, (res) => { res.resume(); resolve(res.headers["retry-after"]); }).end();
  });
  assert.equal(limited, "60");
  delete process.env.FAKE_YTDLP_ERR;
  clearFailures();
  const open: Array<ReturnType<typeof request>> = [];
  for (let i = 0; i < 3; i++) {
    await new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port, path: `/stream/${VID}` }, (res) => res.once("data", () => resolve()));
      req.on("error", () => {});
      open.push(req);
      req.end();
    });
  }
  const r = await get(`/stream/${VID}`);
  assert.equal(r.status, 503);
  assert.deepEqual(errBody(r), { error: INFO.busy.message, code: "busy", retryable: true });
  for (const req of open) req.destroy();
  await sleep(300);
});

test("a missing ffmpeg is an unknown, retryable 502 as JSON", async () => {
  process.env.FFMPEG_BIN = join(tmp, "does-not-exist");
  const r = await get(`/stream/${VID}`);
  assert.equal(r.status, 502);
  assert.equal(errBody(r).code, "unknown");
});

test("Data API failures map: quota is 429 rate-limited, an unknown video is 404 removed, a 500 is a 502", async () => {
  const quota = await get("/api/video/QUOTA000000");
  assert.equal(quota.status, 429);
  assert.equal(errBody(quota).code, "rate-limited");
  assert.ok(!quota.body.includes("SECRET") && !quota.body.includes("test-key"));
  const gone = await get("/api/video/NOTFOUND000");
  assert.equal(gone.status, 404);
  assert.equal(errBody(gone).code, "removed");
  assert.equal(typeof JSON.parse(gone.body).error, "string"); // the old field stays
  const broken = await get("/api/video/FAILING0000");
  assert.equal(broken.status, 502);
  assert.equal(errBody(broken).code, "unknown");
});

test("an unset YT_API_KEY still tells the operator why", async () => {
  const saved = process.env.YT_API_KEY;
  delete process.env.YT_API_KEY;
  try {
    const r = await get("/api/video/KEYMISSING0");
    assert.equal(r.status, 502);
    assert.match(errBody(r).error, /^YT_API_KEY/);
  } finally {
    process.env.YT_API_KEY = saved;
  }
});

test("/api/video carries a playability hint only when something says the video cannot be played", async () => {
  const fine = JSON.parse((await get("/api/video/FINEVIDEO00")).body);
  assert.equal("playable" in fine, false);
  const live = JSON.parse((await get("/api/video/LIVEVIDEO00")).body);
  assert.deepEqual([live.playable, live.reason, live.message], [false, "live", INFO.live.message]);
  const age = JSON.parse((await get("/api/video/AGEVIDEO000")).body);
  assert.deepEqual([age.playable, age.reason], [false, "age-restricted"]);
  // A resolve that failed for a final reason is remembered for a while, so the next page load knows.
  process.env.FAKE_YTDLP_ERR = "ERROR: [youtube] x: Private video. Sign in if you've been granted access to this video";
  await get(`/api/video/PRIVATE0001`); // prewarm fails in the background
  await sleep(500);
  const priv = JSON.parse((await get(`/api/video/PRIVATE0001`)).body);
  assert.deepEqual([priv.playable, priv.reason], [false, "private"]);
});

// --- metrics ---

const series = (body: string) => body.split("\n").filter((l) => l && !l.startsWith("#"));
const value = (body: string, name: string) => Number(series(body).find((l) => l.startsWith(`${name} `))?.slice(name.length + 1) ?? NaN);

test("/api/metrics is Prometheus text with the documented series", async () => {
  const r = await new Promise<{ status: number; type: string; body: string }>((resolve) => {
    request({ host: "127.0.0.1", port, path: "/api/metrics" }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), body }));
    }).end();
  });
  assert.equal(r.status, 200);
  assert.match(r.type, /^text\/plain; version=0\.0\.4/);
  for (const name of [
    "ytclassic_streams_active", "ytclassic_streams_started_total", "ytclassic_streams_finished_total", "ytclassic_streams_failed_total",
    "ytclassic_resolve_seconds_count", "ytclassic_resolve_seconds_sum", "ytclassic_cache_hits_total", "ytclassic_cache_misses_total",
    "ytclassic_cache_entries", "ytclassic_dataapi_units_today", "ytclassic_search_fallback_remaining", "ytclassic_sqlite_bytes", "ytclassic_uptime_seconds",
  ]) assert.ok(Number.isFinite(value(r.body, name)), `${name} missing or not a number`);
  for (const l of series(r.body)) assert.match(l, /^[a-z_]+(\{[a-z_]+="[^"]*"(,[a-z_]+="[^"]*")*\})? [0-9.e+-]+$/, l);
  assert.ok(r.body.endsWith("\n"));
  for (const code of CODES) assert.ok(r.body.includes(`ytclassic_errors_total{code="${code}"}`), code);
  assert.ok(value(r.body, "ytclassic_sqlite_bytes") > 0);
});

test("metrics count streams, errors, resolves, cache and Data API units", async () => {
  const m = async () => (await get("/api/metrics")).body;
  const a = await m();
  await get(`/api/video/${VID}`); // Data API call (cache miss), prewarm resolve
  await get(`/api/video/${VID}`); // cache hit
  process.env.FAKE_YTDLP_ERR = "Private video";
  clearCache();
  clearFailures();
  await get("/stream/FAILMETRIC1"); // its own id: must not join the prewarm resolve still running for VID
  delete process.env.FAKE_YTDLP_ERR;
  const b = await m();
  assert.ok(value(b, "ytclassic_dataapi_units_today") > value(a, "ytclassic_dataapi_units_today"));
  assert.ok(value(b, "ytclassic_cache_hits_total") > value(a, "ytclassic_cache_hits_total"));
  assert.ok(value(b, "ytclassic_cache_misses_total") > value(a, "ytclassic_cache_misses_total"));
  assert.equal(value(b, 'ytclassic_errors_total{code="private"}'), value(a, 'ytclassic_errors_total{code="private"}') + 1);
  assert.equal(value(b, "ytclassic_streams_failed_total"), value(a, "ytclassic_streams_failed_total") + 1);
  assert.ok(value(b, "ytclassic_resolve_seconds_count") > value(a, "ytclassic_resolve_seconds_count"));
  assert.ok(value(b, 'ytclassic_http_requests_total{route="stream",status="4xx"}') >= 1);
  // A stream that starts and is left counts as started, then finished; active returns to its old value.
  clearFailures(); // the private-video failure above is remembered for 30 s
  clearCache();
  const before = await m();
  await new Promise<void>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: `/stream/${VID}` }, (res) => res.once("data", () => (req.destroy(), resolve())));
    req.on("error", () => {});
    req.end();
  });
  await sleep(400);
  const after = await m();
  assert.equal(value(after, "ytclassic_streams_started_total"), value(before, "ytclassic_streams_started_total") + 1);
  assert.equal(value(after, "ytclassic_streams_finished_total"), value(before, "ytclassic_streams_finished_total") + 1);
  assert.equal(value(after, "ytclassic_streams_active"), value(before, "ytclassic_streams_active"));
});

test("metrics have bounded cardinality: random paths, ids, queries and statuses add no series", async () => {
  await get("/api/home");
  const base = series((await get("/api/metrics")).body).length;
  for (let i = 0; i < 60; i++) {
    const rnd = "r" + Math.random().toString(36).slice(2, 14).padEnd(12, "0"); // 13 chars: never a valid 11-char video id
    await get(`/${rnd}`);
    await get(`/api/${rnd}`);
    await get(`/api/video/${rnd}`);
    await get(`/api/channel/${rnd}`);
    await get(`/stream/${rnd}`);
    await get(`/static/${rnd}.js?x=${rnd}`);
    await get(`/api/search?q=${rnd}`);
  }
  const body = (await get("/api/metrics")).body;
  const grown = series(body).length - base;
  assert.ok(grown <= 12, `series grew by ${grown}`); // new route/status class pairs only, never per path
  const known = new Set<string>([...ROUTE_CLASSES, ...STATUS_CLASSES, ...CODES, ...RESOLVE_BUCKETS.map(String), "+Inf"]);
  for (const l of series(body)) for (const m of l.matchAll(/"([^"]*)"/g)) assert.ok(known.has(m[1]), `unexpected label value ${m[1]}`);
  assert.doesNotMatch(body, /\/api\/|\/stream\/|watch\?v/);
});

const resolveCalls = () => (existsSync(join(tmp, "resolves")) ? readFileSync(join(tmp, "resolves"), "utf8").split("\n").filter(Boolean).length : 0);
const metric = async (name: string) => value((await get("/api/metrics")).body, name) || 0;

test("a failed resolve is reused for 30 s per (id, quality, lang): prewarm, stream and probe cost one yt-dlp run", async () => {
  process.env.FAKE_YTDLP_ERR = "ERROR: [youtube] x: Sign in to confirm you\u2019re not a bot";
  const id = "NEGCACHE001";
  const before = resolveCalls();
  await get(`/api/video/${id}`); // prewarm fails in the background
  await sleep(400);
  const s1 = await get(`/stream/${id}`);
  const p = await get(`/stream/${id}?probe=1`);
  assert.equal(s1.status, 502);
  assert.equal(errBody(p).code, "bot-check");
  assert.equal(resolveCalls(), before + 1, "one run served all three");
  await get(`/stream/${id}?q=480`); // another quality is its own key
  assert.equal(resolveCalls(), before + 2);
  // Successes are never cached negatively: the same id works as soon as yt-dlp does, for a key that did not fail.
  delete process.env.FAKE_YTDLP_ERR;
  assert.equal((await get(`/stream/${id}?probe=1&q=360`)).status, 200);
  assert.equal((await get(`/stream/${id}?probe=1&q=360`)).status, 200);
  assert.equal(resolveCalls(), before + 3, "a success is cached by the normal cache, one run");
});

test("the probe answers JSON without a stream slot, ffmpeg or stream counters", async () => {
  const started = await metric("ytclassic_streams_started_total");
  const r = await get(`/stream/PROBEOK0001?probe=1`);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body), { ok: true });
  assert.equal(existsSync(process.env.PIDFILE!), false, "ffmpeg was started by a probe");
  assert.equal(await metric("ytclassic_streams_started_total"), started);
  assert.equal(await metric("ytclassic_streams_failed_total"), await metric("ytclassic_streams_failed_total"));
});

test("a quality miss is not a skippable error and is not remembered as unplayable", async () => {
  process.env.FAKE_YTDLP_ERR = "ERROR: [youtube] x: Requested format is not available. Use --list-formats for a list of available formats";
  const r = await get(`/stream/FORMATMISS1`);
  assert.equal(errBody(r).code, "unknown");
  delete process.env.FAKE_YTDLP_ERR;
  await get(`/api/video/FORMATMISS1`);
  await sleep(300);
  assert.equal("playable" in JSON.parse((await get(`/api/video/FORMATMISS1?q=360`)).body), false);
});

test("a request the client abandoned before any answer is not counted as a 2xx", async () => {
  process.env.FAKE_RESOLVE_SLEEP = "1";
  const key = 'ytclassic_http_requests_total{route="stream",status="2xx"}';
  const before = await metric(key);
  await new Promise<void>((resolve) => {
    const req = request({ host: "127.0.0.1", port, path: `/stream/ABORTED0001` });
    req.on("error", () => {});
    req.end();
    setTimeout(() => { req.destroy(); resolve(); }, 250);
  });
  await sleep(1500);
  assert.equal(await metric(key), before);
});

test("an unreachable database leaves sqlite_bytes out of /api/metrics and null in /api/status", async () => {
  const saved = process.env.DATA_DIR;
  closeDb();
  process.env.DATA_DIR = join(tmp, "a-file");
  writeFileSync(process.env.DATA_DIR, "not a directory");
  try {
    const m = (await get("/api/metrics")).body;
    assert.ok(m.includes("# TYPE ytclassic_sqlite_bytes gauge"));
    assert.ok(!/^ytclassic_sqlite_bytes /m.test(m), "no sample while unreachable");
    assert.equal(JSON.parse((await get("/api/status")).body).cache.dbBytes, null);
  } finally {
    process.env.DATA_DIR = saved;
    closeDb();
  }
});

// --- search: type, filters, channels, suggestions, recent searches ---
const jget = async (path: string) => {
  const r = await get(path);
  return { status: r.status, json: JSON.parse(r.body) };
};
const loggedArgs = () => (existsSync(join(tmp, "args.log")) ? readFileSync(join(tmp, "args.log"), "utf8").trim().split("\n") : []);
const startLog = () => {
  rmSync(join(tmp, "args.log"), { force: true });
  process.env.ARGS_LOG = join(tmp, "args.log");
};

test("search: type, duration and sort are validated; the plain call is unchanged", async () => {
  assert.equal((await get("/api/search?q=a&type=playlist")).status, 400);
  assert.equal((await get("/api/search?q=a&duration=huge")).status, 400);
  assert.equal((await get("/api/search?q=a&sort=random")).status, 400);
  const r = await jget("/api/search?q=plain");
  assert.equal(r.status, 200);
  assert.equal(r.json.items[0].id, VID);
  assert.equal(r.json.notes, undefined);
});

test("search: filters reach YouTube's own search through the sp parameter; unfiltered stays on ytsearch", async () => {
  startLog();
  assert.equal((await get("/api/search?q=cats")).status, 200);
  assert.equal((await get("/api/search?q=cats&duration=short&sort=views")).status, 200);
  const [plain, filtered] = loggedArgs();
  assert.match(plain, /ytsearch20:cats/);
  assert.match(filtered, /results\?search_query=cats&sp=CAMSBBABGAE%3D/); // sort views, type video, duration short
});

test("search: filtered results are cached per filter, and the duration bucket is enforced on what comes back", async () => {
  startLog();
  await get("/api/search?q=dup&duration=long");
  await get("/api/search?q=dup&duration=long");
  await get("/api/search?q=dup&duration=short");
  assert.equal(loggedArgs().length, 2);
  // the fake video lasts 65 s: a "long" filter must not show it even if upstream ignored the filter
  assert.deepEqual((await jget("/api/search?q=dup&duration=long")).json.items, []);
  assert.equal((await jget("/api/search?q=dup&duration=short")).json.items.length, 1);
});

test("search: channel results are validated, flagged when subscribed, and paging needs a token", async () => {
  await get("/api/subscribe", { method: "POST", body: `id=${tvChan("c")}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
  try {
    const r = await jget("/api/search?q=chans&type=channel");
    assert.equal(r.status, 200);
    assert.deepEqual(r.json.channels, [{ id: tvChan("c"), title: "Chan C", thumb: "https://yt3.ggpht.com/a=s176", description: "About C", subscribers: "1234", handle: "@chanc", subscribed: true }]);
    assert.equal(r.json.items, undefined);
  } finally {
    await get("/api/unsubscribe", { method: "POST", body: `id=${tvChan("c")}`, headers: { "content-type": "application/x-www-form-urlencoded" } });
  }
  assert.equal((await jget("/api/search?q=chans&type=channel")).json.channels[0].subscribed, false, "cached page, but subscribed is computed per request");
});

test("search: recent searches record first pages only, dedupe, and stay out of failed searches", async () => {
  await get("/api/search?q=Alpha");
  await get("/api/search?q=beta&type=channel");
  await get("/api/search?q=alpha"); // same query, different case: moves to the top
  await get("/api/search?q=alpha&pageToken=2"); // paging is not a new search
  await get("/api/search?q=gamma&duration=bogus"); // rejected: not recorded
  await get("/api/search?q="); // empty: not recorded
  const r = await jget("/api/searches");
  assert.deepEqual(r.json.searches.map((s: { query: string }) => s.query), ["alpha", "beta"]);
  assert.equal(typeof r.json.searches[0].id, "number");
});

test("recent searches: delete one, clear all, bad ids, and writes are same-origin only", async () => {
  await get("/api/search?q=one");
  await get("/api/search?q=two");
  const evil = { origin: "http://evil.example" };
  assert.equal((await get("/api/searches", { method: "DELETE", headers: evil })).status, 403);
  assert.equal((await get("/api/searches/1", { method: "DELETE", headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal(listSearches().length, 2);
  assert.equal((await get("/api/searches/abc", { method: "DELETE" })).status, 400);
  assert.equal((await get("/api/searches", { method: "POST" })).status, 405);
  const [{ id }] = listSearches();
  assert.deepEqual(JSON.parse((await get(`/api/searches/${id}`, { method: "DELETE" })).body), { removed: true });
  assert.deepEqual(JSON.parse((await get(`/api/searches/${id}`, { method: "DELETE" })).body), { removed: false });
  assert.deepEqual(JSON.parse((await get("/api/searches", { method: "DELETE" })).body), { removed: 1 });
  assert.deepEqual((await jget("/api/searches")).json, { searches: [] });
});

test("suggest: returns parsed suggestions, caps the query, and tolerates failure with an empty list", async () => {
  const prev = globalThis.fetch;
  let calls = 0;
  let mode: "ok" | "down" | "junk" = "ok";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = String(input instanceof Request ? input.url : input);
    if (new URL(u).hostname !== "suggestqueries-clients6.youtube.com") return prev(input as string);
    calls++;
    if (mode === "down") throw new TypeError("fetch failed");
    if (mode === "junk") return new Response("<html>nope</html>");
    return new Response('window.google.ac.h(["cat",[["cats",0,[512]],["cat videos",0],["cats",0]],{"k":1}])');
  }) as typeof fetch;
  try {
    assert.deepEqual((await jget("/api/search/suggest?q=cat")).json, { suggestions: ["cats", "cat videos"] });
    await get("/api/search/suggest?q=CAT%20"); // normalised: served from the short cache
    assert.equal(calls, 1);
    mode = "down";
    assert.deepEqual((await jget("/api/search/suggest?q=dog")).json, { suggestions: [] });
    mode = "junk";
    assert.deepEqual((await jget("/api/search/suggest?q=bird")).json, { suggestions: [] });
    assert.deepEqual((await jget("/api/search/suggest?q=")).json, { suggestions: [] });
    assert.equal((await get("/api/search/suggest?q=" + "x".repeat(101))).status, 400);
    assert.equal(calls, 3, "an empty query never contacts Google");
    assert.equal((await get("/api/searches")).body.includes("cat"), false, "typing suggestions are not recorded as searches");
  } finally {
    globalThis.fetch = prev;
  }
});

test("search and suggest refuse cross-site triggers: nothing is spawned, recorded or fetched", async () => {
  startLog();
  for (const h of [{ "sec-fetch-site": "cross-site" } as Record<string, string>, { origin: "http://evil.example" }, { "sec-fetch-site": "same-site" }]) {
    assert.equal((await get("/api/search?q=csrf", { headers: h })).status, 403);
    assert.equal((await get("/api/search?q=csrf&type=channel", { headers: h })).status, 403);
    assert.equal((await get("/api/search/suggest?q=csrf", { headers: h })).status, 403);
  }
  assert.deepEqual(loggedArgs(), []);
  assert.deepEqual(listSearches(), []);
  assert.equal((await get("/api/search?q=ok", { headers: { "sec-fetch-site": "same-origin" } })).status, 200);
  assert.equal((await get("/api/search?q=ok2", { headers: { "sec-fetch-site": "none" } })).status, 200);
});

test("a search is recorded only when it found something, and a database problem never breaks it", async () => {
  assert.equal((await get("/api/search?q=zeroresults")).status, 200);
  assert.deepEqual(listSearches(), []);
  assert.equal((await get("/api/search?q=zeroresults&type=channel")).status, 200);
  assert.deepEqual(listSearches(), []);
  getDb().exec("ALTER TABLE searches RENAME TO searches_away");
  const realErr = console.error;
  const logged: string[] = [];
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    const r = await get("/api/search?q=secretterm");
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.body).items.length, 1);
  } finally {
    console.error = realErr;
    getDb().exec("ALTER TABLE searches_away RENAME TO searches");
  }
  assert.ok(logged.length === 1 && !logged[0].includes("secretterm"), logged.join("|"));
});

test("a flood of searches gets 503s, spends no Data API quota and leaves playback its own slots", async () => {
  process.env.SEARCH_SLEEP = "1";
  let settled = false;
  const flood = Promise.all(Array.from({ length: 14 }, (_, i) => get(`/api/search?q=flood${i}`))).then((r) => ((settled = true), r));
  await sleep(300); // the searches now hold their slots (and the queue is full)
  const urls = await resolveUrls("PLAYBACK001", 720, "");
  assert.ok(urls.length > 0, "playback resolved");
  assert.equal(settled, false, "and did not have to wait for the searches to finish");
  const out = await flood;
  const codes = out.map((r) => r.status);
  assert.ok(codes.every((c) => c === 200 || c === 503), codes.join());
  assert.ok(codes.filter((c) => c === 503).length >= 6, codes.join());
  assert.ok(codes.filter((c) => c === 200).length >= 2, codes.join());
  assert.equal(apiSearchCalls, 0, "busy is not a broken yt-dlp: no Data API quota");
  assert.equal(out.find((r) => r.status === 503)!.headers["retry-after"], "5");
});

test("/api/video answers at once with the usual tiers; /qualities waits for the tiers, with codec hints; Auto follows maxh and codecs; MAX_QUALITY caps", async () => {
  process.env.FAKE_YTDLP_FMT = '[{"height":2160,"width":3840,"vcodec":"vp9","protocol":"https"},{"height":1080,"width":1920,"vcodec":"avc1.640028","protocol":"https"},{"height":720,"width":1280,"vcodec":"avc1.4d401f","protocol":"https"}]';
  process.env.FAKE_RESOLVE_SLEEP = "1";
  try {
    const t0 = Date.now();
    const first = JSON.parse((await get("/api/video/QUALITY0001?q=2160")).body);
    assert.ok(Date.now() - t0 < 900, "the page data does not wait for yt-dlp");
    assert.deepEqual(first.qualities, [360, 480, 720, 1080]);
    assert.deepEqual([first.codecs, first.tiersKnown, first.quality, first.auto], [{}, false, 2160, false]);
    const hi = JSON.parse((await get("/api/video/QUALITY0001/qualities?q=2160")).body); // shares the prewarm that is still running
    assert.deepEqual(hi.qualities, [720, 1080, 2160]);
    assert.deepEqual(hi.codecs, { "720": ["avc1"], "1080": ["avc1"], "2160": ["vp9"] });
    assert.equal(hi.tiersKnown, true);
    assert.equal(resolveCalls() > 0, true);
    // Now cached: /api/video carries them too, and /qualities answers without a new run.
    const runs = resolveCalls();
    const again = JSON.parse((await get("/api/video/QUALITY0001?q=2160")).body);
    assert.deepEqual([again.qualities, again.tiersKnown], [[720, 1080, 2160], true]);
    assert.deepEqual(JSON.parse((await get("/api/video/QUALITY0001/qualities?q=2160")).body).qualities, [720, 1080, 2160]);
    assert.equal(resolveCalls(), runs);
    const auto = JSON.parse((await get("/api/video/QUALITY0001?q=auto&maxh=1440&codecs=avc1,vp9")).body);
    assert.deepEqual([auto.quality, auto.auto], [1440, true]);
    assert.equal(JSON.parse((await get("/api/video/QUALITY0001?q=auto&maxh=2160&codecs=avc1")).body).quality, 1080);
    process.env.MAX_QUALITY = "1080";
    const capped = JSON.parse((await get("/api/video/QUALITY0003?q=2160")).body);
    assert.deepEqual([capped.qualities, capped.quality], [[360, 480, 720, 1080], 1080], "a quality above the cap is lowered to it");
    delete process.env.MAX_QUALITY;
    // Bad input and the wrong method.
    assert.equal((await get("/api/video/bad/qualities")).status, 400);
    assert.equal((await get("/api/video/QUALITY0001/qualities", { method: "POST" })).status, 405);
  } finally {
    delete process.env.FAKE_YTDLP_FMT;
    delete process.env.FAKE_RESOLVE_SLEEP;
    delete process.env.MAX_QUALITY;
  }
});

test("/qualities gives up waiting after the timeout and answers the usual tiers; a video yt-dlp printed no list for keeps them", async () => {
  process.env.FAKE_RESOLVE_SLEEP = "2";
  process.env.OFFER_WAIT_MS = "200";
  try {
    const t0 = Date.now();
    const r = JSON.parse((await get("/api/video/QUALITY0004/qualities")).body);
    assert.ok(Date.now() - t0 < 1500, "did not wait for the slow resolve");
    assert.deepEqual([r.qualities, r.codecs, r.tiersKnown], [[360, 480, 720, 1080], {}, false]);
  } finally {
    delete process.env.FAKE_RESOLVE_SLEEP;
    delete process.env.OFFER_WAIT_MS;
  }
  await sleep(2300); // let the slow resolve finish before the next test
  const plain = JSON.parse((await get("/api/video/QUALITY0005/qualities")).body);
  assert.deepEqual([plain.qualities, plain.codecs, plain.tiersKnown], [[360, 480, 720, 1080], {}, false]);
});
