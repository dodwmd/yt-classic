import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { clearCache, forget } from "../cache.ts";
import { classifyError, errorBody, NoStoryboard } from "../errors.ts";
import { killChildren } from "./dlp.ts";
import { MAX_SHEET_BYTES, allowedSheetUrl, parseStoryboards, resetStoryboards } from "./storyboard.ts";

const VID = "AAAAAAAAAAA";
const NONE = "BBBBBBBBBBB";
const TOKEN = "correct-horse-battery-staple-TEST";
// Real yt-dlp output (`%(formats)j` of a 213 s video, storyboard entries only; ids and signatures replaced).
const FORMATS = JSON.parse(readFileSync(new URL("./fixtures/storyboard-formats.json", import.meta.url), "utf8")) as Array<Record<string, unknown>>;
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

test("parseStoryboards: the widest level up to 320 px, from real yt-dlp output", () => {
  const i = parseStoryboards(213, FORMATS);
  assert.deepEqual(i.desc, { tiles: { w: 320, h: 180, cols: 3, rows: 3, count: 108, interval: 1.972, sheets: 12 }, duration: 213 });
  assert.equal(i.urls.length, 12);
  assert.ok(i.urls.every((u) => u.startsWith("https://i.ytimg.com/")));
});

test("parseStoryboards: long videos fall back to a narrower level, several levels, none, junk", () => {
  const sb = (id: string, w: number, per: number, sheets: number, fps = 0.5) => ({
    format_id: id, width: w, height: Math.round((w * 9) / 16), fps, rows: per, columns: per,
    fragments: Array.from({ length: sheets }, (_, n) => ({ url: `https://i.ytimg.com/sb/x/${id}/M${n}.jpg`, duration: (per * per) / fps })),
  });
  const long = parseStoryboards(7200, [sb("sb0", 320, 3, 400), sb("sb1", 160, 5, 144), sb("sb2", 80, 10, 36), sb("sb3", 48, 10, 8)]);
  assert.equal(long.desc!.tiles.w, 160, "400 sheets of 320 px is too many; 144 of 160 px is still above 40, so the narrowest in range wins");
  const mid = parseStoryboards(3000, [sb("sb0", 320, 5, 120), sb("sb1", 160, 5, 30), sb("sb2", 80, 10, 10)]);
  assert.equal(mid.desc!.tiles.w, 160);
  assert.equal(parseStoryboards(100, [sb("sb3", 48, 10, 1)]).desc!.tiles.w, 48, "only a tiny level exists: use it");
  for (const bad of [null, undefined, "x", {}, [], [{ format_id: "sb0" }], [{ format_id: "248", width: 320 }], [sb("sb0", 320, 3, 0)]]) assert.equal(parseStoryboards(10, bad).desc, null);
  const foreign = sb("sb0", 320, 3, 2);
  foreign.fragments[1].url = "https://evil.com/x.jpg";
  assert.equal(parseStoryboards(10, [foreign]).desc, null, "a level with a foreign host is unusable");
  const ragged = sb("sb0", 320, 3, 3);
  ragged.fragments[0].duration = 4; // a short sheet before the last one: the client's arithmetic would be wrong
  assert.equal(parseStoryboards(10, [ragged]).desc, null);
  assert.equal(parseStoryboards(NaN, [sb("sb0", 320, 3, 2)]).desc!.duration, 36, "no duration: derived from the tiles");
  assert.equal(parseStoryboards(10, [{ ...sb("sb0", 320, 3, 1), fps: 0 }]).desc, null);
});

test("host allowlist: exact or dot-suffix matches on https only", () => {
  for (const ok of ["https://i.ytimg.com/sb/x.jpg", "https://ytimg.com/x", "https://i9.ytimg.com/x", "https://rr1---sn-x.googlevideo.com/y", "https://yt3.ggpht.com/z", "https://I.YTIMG.COM/x", "https://i.ytimg.com:443/x"]) assert.ok(allowedSheetUrl(ok), ok);
  for (const bad of ["http://i.ytimg.com/x", "https://evil.com/x", "https://i.ytimg.com@evil.com/x", "https://user:pw@i.ytimg.com/x", "https://i.ytimg.com:8443/x", "https://i.ytimg.com.evil.com/x", "https://evilytimg.com/x", "https://eviltimg.com/x", "https://notggpht.com/x",
    "https://ytimg.com.evil.com/", "https://127.0.0.1/x", "https://localhost/x", "file:///etc/passwd", "//evil.com", "not a url", "https://i.ytimg.com%2eevil.com/x", "https://youtube.com/x", "https://www.youtube.com/x"]) assert.equal(allowedSheetUrl(bad), null, bad);
});

test("errors: no-storyboard is a classified 404 without leaks", () => {
  assert.equal(classifyError(new NoStoryboard("https://i.ytimg.com/secret")), "no-storyboard");
  assert.deepEqual(errorBody("no-storyboard"), { error: "This video has no scrub previews.", code: "no-storyboard", retryable: false });
});

let server: Server;
let port = 0;
let tmp = "";
const realFetch = globalThis.fetch;
const realErr = console.error;
const realLog = console.log;
let fetched: string[] = [];
let mode: "ok" | "big" | "bigdeclared" | "html" | "404" | "429" | "reject" | "403" | "403once" | "stall" | "webp" = "ok";

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "yt-sb-"));
  process.env.DATA_DIR = join(tmp, "data");
  process.env.YT_API_KEY = "test-key";
  process.env.PIDFILE = join(tmp, "ffmpeg.pid");
  const p = join(tmp, "yt-dlp");
  writeFileSync(join(tmp, "formats.json"), JSON.stringify(FORMATS));
  writeFileSync(p, `#!/bin/sh
echo x >> "${tmp}/calls"
case "$*" in
  *${NONE}*) echo 213; echo '[{"format_id":"18","width":640}]';;
  *EEEEEEEEEEE*) echo 'ERROR: [youtube] EEEEEEEEEEE: Sign in to confirm you are not a bot' >&2; exit 1;;
  *) echo 213; cat "${tmp}/formats.json";;
esac
`);
  chmodSync(p, 0o755);
  process.env.YTDLP_BIN = p;
  process.env.FFMPEG_BIN = "/bin/false";
  console.log = () => {};
  console.error = () => {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input);
    if (!u.includes("ytimg")) return realFetch(input, init);
    fetched.push(u);
    assert.equal(init?.redirect, "error", "redirects are refused");
    const img = { "content-type": "image/jpeg" };
    if (mode === "reject") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (mode === "403") return new Response("", { status: 403 });
    if (mode === "403once") {
      mode = "ok";
      return new Response("", { status: 403 });
    }
    if (mode === "404") return new Response("", { status: 404 });
    if (mode === "429") return new Response("", { status: 429 });
    if (mode === "html") return new Response("<html>consent</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (mode === "webp") return new Response(JPEG, { status: 200, headers: { "content-type": "image/webp" } });
    if (mode === "big") return new Response(new ReadableStream({ start(c) { for (let i = 0; i < 4; i++) c.enqueue(new Uint8Array(MAX_SHEET_BYTES / 3)); c.close(); } }), { status: 200, headers: img });
    if (mode === "bigdeclared") return new Response(JPEG, { status: 200, headers: { ...img, "content-length": String(MAX_SHEET_BYTES + 1) } });
    if (mode === "stall") {
      const sig = init?.signal;
      return new Response(new ReadableStream({ start(c) { c.enqueue(JPEG); sig?.addEventListener("abort", () => c.error(sig.reason)); } }), { status: 200, headers: img });
    }
    return new Response(JPEG, { status: 200, headers: img });
  }) as typeof fetch;
  server = createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  globalThis.fetch = realFetch;
  console.error = realErr;
  console.log = realLog;
  killChildren();
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  delete process.env.ACCESS_TOKEN;
  clearCache();
  for (const id of [VID, NONE, "EEEEEEEEEEE"]) forget(`sbdesc:${id}`); // the persisted descriptors survive clearCache()
  resetStoryboards();
  fetched = [];
  mode = "ok";
  rmSync(join(tmp, "calls"), { force: true });
});

type Res = { status: number; body: Buffer; text: string; headers: IncomingHttpHeaders };
const call = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Promise<Res>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (d: Buffer) => parts.push(d));
      res.on("end", () => {
        const body = Buffer.concat(parts);
        resolve({ status: res.statusCode ?? 0, body, text: body.toString("latin1"), headers: res.headers });
      });
    });
    req.on("error", reject);
    req.end();
  });
const callCount = () => (existsSync(join(tmp, "calls")) ? readFileSync(join(tmp, "calls"), "utf8").trim().split("\n").length : 0);

test("GET /api/video/:id/storyboard returns the descriptor and no URLs", async () => {
  const r = await call(`/api/video/${VID}/storyboard`);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { tiles: { w: 320, h: 180, cols: 3, rows: 3, count: 108, interval: 1.972, sheets: 12 }, duration: 213 });
  assert.doesNotMatch(r.text, /https?:|ytimg|sqp|sigh/);
  assert.equal(fetched.length, 0);
});

test("the descriptor (and only it) is persisted: after a restart it needs no yt-dlp, a sheet does", async () => {
  await call(`/api/video/${VID}/storyboard`);
  clearCache();
  assert.equal((await call(`/api/video/${VID}/storyboard`)).status, 200);
  assert.equal(callCount(), 1);
  assert.equal((await call(`/api/video/${VID}/storyboard/0.jpg`)).status, 200);
  assert.equal(callCount(), 2, "the URLs were never written to disk");
});

test("sheets: image bytes with headers, cached, only through id and index", async () => {
  const r = await call(`/api/video/${VID}/storyboard/3.jpg`);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "image/jpeg");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.match(String(r.headers["cache-control"]), /max-age=3600/);
  assert.ok(r.body.equals(JPEG));
  assert.match(fetched[0], /^https:\/\/i\.ytimg\.com\/.*M3\.jpg/);
  await call(`/api/video/${VID}/storyboard/3.jpg`);
  assert.equal(fetched.length, 1, "second request served from memory");
  assert.equal(callCount(), 1, "one yt-dlp run for the descriptor, the URLs and the sheets");
  await call(`/api/video/${VID}/storyboard`);
  assert.equal(callCount(), 1);
  mode = "webp";
  assert.equal((await call(`/api/video/${VID}/storyboard/4.jpg`)).headers["content-type"], "image/webp");
});

test("n must be an integer inside [0, sheets)", async () => {
  assert.equal((await call(`/api/video/${VID}/storyboard/11.jpg`)).status, 200);
  for (const bad of ["12", "999", "9999"]) {
    const r = await call(`/api/video/${VID}/storyboard/${bad}.jpg`);
    assert.equal(r.status, 404, bad);
    assert.equal(JSON.parse(r.text).code, "no-storyboard");
  }
  for (const bad of ["-1", "1.5", "x", "01x", "%2e%2e", "10000", ""]) assert.ok((await call(`/api/video/${VID}/storyboard/${bad}.jpg`)).status >= 400, bad);
  assert.equal((await call(`/api/video/${VID}/storyboard/0.png`)).status, 400);
  assert.equal(fetched.length, 1, "only the valid request fetched");
});

test("a video without a storyboard is 404 no-storyboard, remembered, and yt-dlp is not asked again", async () => {
  for (const path of [`/api/video/${NONE}/storyboard`, `/api/video/${NONE}/storyboard/0.jpg`, `/api/video/${NONE}/storyboard`]) {
    const r = await call(path);
    assert.equal(r.status, 404, path);
    assert.deepEqual(JSON.parse(r.text), { error: "This video has no scrub previews.", code: "no-storyboard", retryable: false });
  }
  assert.equal(callCount(), 1);
  assert.equal(fetched.length, 0);
});

test("bad id, wrong method", async () => {
  assert.equal((await call(`/api/video/short/storyboard`)).status, 400);
  assert.equal((await call(`/api/video/${VID}/storyboard`, {}, "POST")).status, 405);
  assert.equal((await call(`/api/video/${VID}/storyboard/0.jpg`, {}, "DELETE")).status, 405);
  assert.equal(callCount(), 0);
});

test("size cap while streaming and declared, content type, upstream failures: classified, nothing leaks", async () => {
  const cases: Array<[typeof mode, number, string]> = [["big", 404, "no-storyboard"], ["bigdeclared", 404, "no-storyboard"], ["html", 404, "no-storyboard"], ["404", 404, "no-storyboard"], ["429", 429, "rate-limited"], ["reject", 502, "network"]];
  for (const [m, status, code] of cases) {
    resetStoryboards();
    mode = m;
    const r = await call(`/api/video/${VID}/storyboard/0.jpg`);
    assert.equal(r.status, status, m);
    assert.equal(JSON.parse(r.text).code, code, m);
    assert.doesNotMatch(r.text, /https?:|ytimg|\/tmp|sqp/i, m);
  }
  mode = "ok";
  assert.equal((await call(`/api/video/${VID}/storyboard/0.jpg`)).status, 200, "failures are not cached");
});

test("a stalled sheet is cut off by the timeout", async () => {
  process.env.STORYBOARD_FETCH_TIMEOUT_MS = "300";
  try {
    mode = "stall";
    const r = await call(`/api/video/${VID}/storyboard/0.jpg`);
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.text).code, "network");
  } finally {
    delete process.env.STORYBOARD_FETCH_TIMEOUT_MS;
  }
});

test("an expired sheet URL (403) is refreshed once through yt-dlp; a persistent 403 is not retried forever", async () => {
  await call(`/api/video/${VID}/storyboard`);
  assert.equal(callCount(), 1);
  mode = "403once";
  assert.equal((await call(`/api/video/${VID}/storyboard/1.jpg`)).status, 200);
  assert.equal(callCount(), 2);
  resetStoryboards();
  mode = "403";
  assert.equal((await call(`/api/video/${VID}/storyboard/2.jpg`)).status, 502);
  assert.equal(callCount(), 3, "one refresh only");
});

test("concurrent requests for one sheet share a single download", async () => {
  const rs = await Promise.all([1, 2, 3, 4].map(() => call(`/api/video/${VID}/storyboard/5.jpg`)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(fetched.length, 1);
  assert.equal(callCount(), 1);
});

test("the sheet cache is bounded by bytes (oldest out first)", async () => {
  // 12 sheets of ~2 KB fit; this only checks eviction does not break serving after many distinct sheets.
  for (let n = 0; n < 12; n++) assert.equal((await call(`/api/video/${VID}/storyboard/${n}.jpg`)).status, 200);
  assert.equal(fetched.length, 12);
});

test("a failing yt-dlp is classified and spawned once for repeats", async () => {
  const a = await call(`/api/video/EEEEEEEEEEE/storyboard`);
  const b = await call(`/api/video/EEEEEEEEEEE/storyboard/0.jpg`);
  for (const r of [a, b]) assert.equal(JSON.parse(r.text).code, "bot-check");
  assert.equal(callCount(), 1);
});

test("the access token gates both routes and nothing runs without it", async () => {
  process.env.ACCESS_TOKEN = TOKEN;
  for (const path of [`/api/video/${VID}/storyboard`, `/api/video/${VID}/storyboard/0.jpg`]) {
    assert.equal((await call(path)).status, 401, path);
    assert.equal((await call(path, { authorization: "Bearer wrong-token-wrong-token-12345" })).status, 401, path);
    assert.equal((await call(path, { authorization: `Bearer ${TOKEN}` })).status, 200, path);
  }
  rmSync(join(tmp, "calls"), { force: true });
  clearCache();
  forget(`sbdesc:${NONE}`);
  resetStoryboards();
  fetched = [];
  assert.equal((await call(`/api/video/${NONE}/storyboard`)).status, 401);
  assert.equal((await call(`/api/video/${NONE}/storyboard/0.jpg`, { "sec-fetch-site": "cross-site" })).status, 401);
  assert.equal(existsSync(join(tmp, "calls")), false, "unauthenticated requests never spawn yt-dlp");
  assert.equal(fetched.length, 0);
});

test("a cached 'none' is kept 10 minutes, a storyboard 1 hour (fake clock)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await call(`/api/video/${NONE}/storyboard`);
  await call(`/api/video/${VID}/storyboard`);
  assert.equal(callCount(), 2);
  t.mock.timers.tick(9 * 60_000);
  await call(`/api/video/${NONE}/storyboard`);
  await call(`/api/video/${VID}/storyboard`);
  assert.equal(callCount(), 2);
  t.mock.timers.tick(2 * 60_000);
  await call(`/api/video/${NONE}/storyboard`);
  assert.equal(callCount(), 3, "the empty result expired");
  await call(`/api/video/${VID}/storyboard`);
  assert.equal(callCount(), 3);
  t.mock.timers.tick(55 * 60_000);
  await call(`/api/video/${VID}/storyboard`);
  assert.equal(callCount(), 4);
});
