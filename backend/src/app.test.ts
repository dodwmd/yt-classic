import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { clearCache } from "./cache.ts";
import { getDb } from "./db.ts";
import { clearHistory } from "./history.ts";
import { deletePlaylist, listPlaylists, resetLookupLimit, noteLookup, MAX_LOOKUPS_PER_HOUR } from "./playlists.ts";
import { killChildren } from "./yt/dlp.ts";

const CHANNEL = "UC" + "a".repeat(22);
const VID = "AAAAAAAAAAA";

let server: Server;
let port = 0;
let tmp = "";
const realFetch = globalThis.fetch;
let videoCalls = 0;

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
if [ "$mode" = g ]; then sleep "\${FAKE_RESOLVE_SLEEP:-0}"; echo https://example.invalid/v; echo https://example.invalid/a
else echo '{"entries":[{"id":"${VID}","title":"<script>alert(1)</script>","channel":"Chan","channel_id":"${CHANNEL}","duration":65,"view_count":10}]}'; fi`,
  );
  process.env.FFMPEG_BIN = script("ffmpeg", `echo $$ > "$PIDFILE"; printf xxxx; exec sleep 30`);
  // Stub only the YouTube Data API; nothing here touches the network.
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = input instanceof Request ? input.url : String(input);
    if (u.includes("/youtube/v3/channels")) {
      const item = { id: CHANNEL, snippet: { title: "Chan", description: "d", thumbnails: {} }, statistics: {}, brandingSettings: {} };
      return new Response(JSON.stringify({ items: [item] }), { status: 200 });
    }
    if (u.includes("/youtube/v3/videos")) {
      videoCalls++;
      const id = new URL(u).searchParams.get("id");
      if (id === "FAILING0000") return new Response("{}", { status: 500 });
      if (id === "NOTFOUND000") return new Response(JSON.stringify({ items: [] }), { status: 200 });
      const item = {
        id, snippet: { title: "Server title", channelId: CHANNEL, channelTitle: "Server chan", description: "d", publishedAt: "2026-01-01T00:00:00Z", thumbnails: { medium: { url: "https://i.ytimg.com/server.jpg" } } },
        contentDetails: { duration: "PT10M" }, statistics: {},
      };
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
  resetLookupLimit();
  for (const p of listPlaylists()) if (!p.builtin) deletePlaylist(p.id);
  getDb().exec("DELETE FROM playlist_items");
  videoCalls = 0;
  rmSync(process.env.PIDFILE!, { force: true });
  delete process.env.FAKE_RESOLVE_SLEEP;
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

test("/api/home returns exactly the subscriptions and the feed (no suggestion rows)", async () => {
  const r = await get("/api/home");
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(JSON.parse(r.body)).sort(), ["continue", "feed", "subs"]);
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
