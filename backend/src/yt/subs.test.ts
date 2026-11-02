import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { clearCache } from "../cache.ts";
import { killChildren } from "./dlp.ts";
import { MAX_TRACKS, MAX_VTT_BYTES, SUB_LANG, allowedSubUrl, parseSubs, resetSubs, selectTracks } from "./subs.ts";

const VID = "AAAAAAAAAAA";
const NOSUB = "BBBBBBBBBBB";
const TOKEN = "correct-horse-battery-staple-TEST";
const TT = "https://www.youtube.com/api/timedtext?v=AAAAAAAAAAA&caps=asr&exp=xpe&lang=";

// Shaped like yt-dlp's %(subtitles)j / %(automatic_captions)j output.
const fmts = (lang: string, name: string, exts = ["vtt", "srv3", "ttml"]) => exts.map((ext) => ({ ext, url: `${TT}${lang}&fmt=${ext}`, name }));
const MANUAL = { en: fmts("en", "English"), de: fmts("de", "German", ["srv3", "json3"]), live_chat: [{ ext: "json", url: "https://www.youtube.com/live_chat?x=1" }] };
const AUTO = { "en-orig": fmts("en-orig", "English (Original)"), en: fmts("en", "English"), fr: fmts("fr", "French"), "zh-Hans": fmts("zh-Hans", "Chinese (Simplified)") };
const VTT = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nhello\n";

test("parseSubs/selectTracks: manual first, one URL per language, live_chat and junk keys dropped", () => {
  const info = parseSubs(MANUAL, AUTO);
  const tracks = selectTracks(info);
  assert.deepEqual(tracks.map((t) => [t.lang, t.auto]), [["en", false], ["de", false], ["en-orig", true], ["fr", true], ["zh-Hans", true]]);
  assert.equal(tracks[0].name, "English");
  assert.match(info.manual.get("en")!.url, /fmt=vtt/);
  assert.match(info.manual.get("de")!.url, /fmt=vtt/, "a track without a vtt entry is asked for as vtt");
  assert.doesNotMatch(info.manual.get("de")!.url, /fmt=json3|fmt=srv3/);
  for (const t of tracks) assert.deepEqual(Object.keys(t).sort(), ["auto", "lang", "name"], "no URL in the track list");
  assert.equal(parseSubs({ "a.en": fmts("en", "x"), "en.x": fmts("en", "x") }, null).manual.size, 0, "translation-style keys are skipped");
  assert.deepEqual(selectTracks(parseSubs(null, undefined)), []);
  assert.deepEqual(selectTracks(parseSubs([], "x")), []);
  assert.deepEqual(selectTracks(parseSubs({ en: "nope", de: [{ ext: "vtt" }], fr: [{ ext: "vtt", url: "http://www.youtube.com/x" }] }, {})), []);
});

test("selectTracks: capped, the viewer's language is never cut, originals and manual-matching languages come first", () => {
  const many: Record<string, unknown> = { "en-orig": fmts("x", "o"), "pt-BR": fmts("x", "p") };
  for (let i = 0; i < 100; i++) many[`aa-v${String(i).padStart(3, "0")}`] = fmts("x", "n");
  const info = parseSubs({ pt: fmts("pt", "Portuguese") }, many);
  const plain = selectTracks(info);
  assert.equal(plain.length, MAX_TRACKS);
  assert.deepEqual(plain.slice(0, 3).map((t) => t.lang), ["pt", "en-orig", "pt-BR"], "manual, then originals, then languages with a manual track");
  const withPref = selectTracks(info, "aa-v099");
  assert.equal(withPref.length, MAX_TRACKS);
  assert.ok(withPref.some((t) => t.lang === "aa-v099"));
  assert.equal(withPref[1].lang, "aa-v099", "the preferred automatic language leads the automatic ones");
  const { tracks } = { tracks: selectTracks(parseSubs({ en: [{ ext: "vtt", url: TT + "en", name: "Eng\u0007\nlish" + "x".repeat(100) }], fr: [{ ext: "vtt", url: TT + "fr", name: 5 }] }, {})) };
  assert.ok(!/\p{Cc}/u.test(tracks[0].name) && tracks[0].name.length <= 60);
  assert.equal(tracks[1].name, "fr");
});

test("language codes", () => {
  for (const ok of ["en", "pt-BR", "zh-Hans", "en-orig", "fil", "es_419", "sr-Latn-RS"]) assert.match(ok, SUB_LANG);
  for (const bad of ["", "e", "english", "en/../x", "en.vtt", "en;rm", "-en", "en-", "en--x", "a".repeat(40), "../x", "en%20", "live_chat", "__proto__"]) assert.doesNotMatch(bad, SUB_LANG, bad);
});

test("SSRF guard: https on youtube.com / googlevideo.com only", () => {
  for (const ok of ["https://www.youtube.com/api/timedtext?a=1", "https://youtube.com/x", "https://rr1---sn-x.googlevideo.com/y", "https://WWW.YOUTUBE.COM/x"]) assert.ok(allowedSubUrl(ok), ok);
  for (const bad of ["http://www.youtube.com/x", "https://evil.com/x", "https://youtube.com.evil.com/x", "https://evilyoutube.com/x", "https://www.youtube.com@evil.com/x", "https://user:pw@www.youtube.com/x",
    "https://www.youtube.com:8443/x", "https://127.0.0.1/x", "https://localhost/x", "file:///etc/passwd", "javascript:1", "//evil.com", "not a url", "https://notgooglevideo.com/x", "https://www.youtube.com.evil.com/"]) assert.equal(allowedSubUrl(bad), null, bad);
});

let server: Server;
let port = 0;
let tmp = "";
const realFetch = globalThis.fetch;
const realErr = console.error;
const realLog = console.log;
let fetched: string[] = [];
let fetchMode: "ok" | "big" | "html" | "404" | "429" | "reject" | "403" | "403once" | "stall" = "ok";

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "yt-subs-"));
  process.env.DATA_DIR = join(tmp, "data");
  process.env.YT_API_KEY = "test-key";
  process.env.PIDFILE = join(tmp, "ffmpeg.pid");
  const p = join(tmp, "yt-dlp");
  writeFileSync(p, `#!/bin/sh
echo x >> "${tmp}/calls"
case "$*" in
  *${NOSUB}*) echo '{}'; echo '{}';;
  *DDDDDDDDDDD*) sleep 5;;
  *EEEEEEEEEEE*) echo 'ERROR: [youtube] EEEEEEEEEEE: Sign in to confirm you are not a bot' >&2; exit 1;;
  *SLOW*) sleep 1; echo '{}'; echo '{}';;
  *CCCCCCCCCCC*) echo 'ERROR: [youtube] CCCCCCCCCCC: Private video. Sign in if you have been granted access' >&2; exit 1;;
  *) echo '${JSON.stringify(MANUAL)}'; echo '${JSON.stringify(AUTO)}';;
esac
`);
  chmodSync(p, 0o755);
  process.env.YTDLP_BIN = p;
  process.env.FFMPEG_BIN = "/bin/false";
  console.log = () => {};
  console.error = () => {};
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = input instanceof Request ? input.url : String(input);
    if (!u.includes("timedtext")) return realFetch(input, init);
    fetched.push(u);
    assert.equal(init?.redirect, "error", "redirects are refused");
    if (fetchMode === "reject") throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
    if (fetchMode === "403") return new Response("", { status: 403 });
    if (fetchMode === "403once") {
      fetchMode = "ok";
      return new Response("", { status: 403 });
    }
    if (fetchMode === "stall") { // headers arrive, the body never ends (until the request's own timeout aborts it)
      const sig = init?.signal;
      return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("WEBVTT\n")); sig?.addEventListener("abort", () => c.error(sig.reason)); } }), { status: 200 });
    }
    if (fetchMode === "404") return new Response("", { status: 404 });
    if (fetchMode === "429") return new Response("", { status: 429 });
    if (fetchMode === "html") return new Response("<html>consent</html>", { status: 200 });
    if (fetchMode === "big") return new Response("WEBVTT\n\n" + "x".repeat(MAX_VTT_BYTES + 10), { status: 200 });
    return new Response(VTT, { status: 200, headers: { "content-type": "text/vtt" } });
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
  resetSubs();
  fetched = [];
  fetchMode = "ok";
  rmSync(join(tmp, "calls"), { force: true });
});

type Res = { status: number; body: string; headers: IncomingHttpHeaders };
const call = (path: string, headers: Record<string, string> = {}, method = "GET") =>
  new Promise<Res>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on("error", reject);
    req.end();
  });

test("GET /api/video/:id/subs lists the tracks, without URLs", async () => {
  const r = await call(`/api/video/${VID}/subs`);
  assert.equal(r.status, 200);
  const body = JSON.parse(r.body);
  assert.deepEqual(body.tracks.map((t: { lang: string }) => t.lang), ["en", "de", "en-orig", "fr", "zh-Hans"]);
  assert.doesNotMatch(r.body, /https?:|timedtext/);
});

test("a video without subtitles: empty list, vtt is 404 no-subtitles, and yt-dlp is not asked again", async () => {
  const l = await call(`/api/video/${NOSUB}/subs`);
  assert.equal(l.status, 200);
  assert.deepEqual(JSON.parse(l.body), { tracks: [] });
  const v = await call(`/api/video/${NOSUB}/subs/en.vtt`);
  assert.equal(v.status, 404);
  assert.deepEqual(JSON.parse(v.body), { error: "This video has no subtitles in that language.", code: "no-subtitles", retryable: false });
  await call(`/api/video/${NOSUB}/subs/en.vtt`);
  await call(`/api/video/${NOSUB}/subs`);
  await call(`/api/video/${NOSUB}/subs/en.vtt`);
  assert.equal(readFileSync(join(tmp, "calls"), "utf8").trim().split("\n").length, 1);
});

test("an unknown language on a video with subs is 404 no-subtitles", async () => {
  const r = await call(`/api/video/${VID}/subs/ja.vtt`);
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.body).code, "no-subtitles");
  assert.equal(fetched.length, 0);
});

test("GET .../subs/:lang.vtt serves WebVTT with the right headers and caches it", async () => {
  const r = await call(`/api/video/${VID}/subs/en.vtt`);
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/vtt; charset=utf-8");
  assert.equal(r.headers["x-content-type-options"], "nosniff");
  assert.equal(r.body, VTT);
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /^https:\/\/www\.youtube\.com\/api\/timedtext\?/);
  assert.equal((await call(`/api/video/${VID}/subs/en.vtt`)).body, VTT);
  assert.equal(fetched.length, 1, "second request served from the cache");
  await call(`/api/video/${VID}/subs/de.vtt`);
  assert.equal(fetched.length, 2);
  assert.match(fetched[1], /lang=de&fmt=vtt/);
});

test("bad language, wrong method, bad id", async () => {
  assert.equal((await call(`/api/video/${VID}/subs/en%2f..%2fx.vtt`)).status, 400);
  assert.equal((await call(`/api/video/${VID}/subs/toolongcode123456.vtt`)).status, 400);
  assert.equal((await call(`/api/video/${VID}/subs/e.vtt`)).status, 400);
  assert.equal((await call(`/api/video/${VID}/subs`, {}, "POST")).status, 405);
  assert.equal((await call(`/api/video/short/subs`)).status, 400);
  assert.equal(fetched.length, 0);
});

test("size cap, non-WebVTT bodies and upstream failures are classified and leak nothing", async () => {
  const cases: Array<[typeof fetchMode, number, string]> = [["big", 404, "no-subtitles"], ["html", 404, "no-subtitles"], ["404", 404, "no-subtitles"], ["429", 429, "rate-limited"], ["reject", 502, "network"]];
  for (const [mode, status, code] of cases) {
    resetSubs();
    fetchMode = mode;
    const r = await call(`/api/video/${VID}/subs/en.vtt`);
    assert.equal(r.status, status, mode);
    assert.equal(JSON.parse(r.body).code, code, mode);
    assert.doesNotMatch(r.body, /https?:|timedtext|youtube\.com|\/tmp/i, mode);
  }
  fetchMode = "ok";
  assert.equal((await call(`/api/video/${VID}/subs/en.vtt`)).status, 200, "failures are not cached");
});

test("yt-dlp failures are classified", async () => {
  const r = await call(`/api/video/CCCCCCCCCCC/subs`);
  assert.equal(r.status, 404);
  assert.equal(JSON.parse(r.body).code, "private");
  assert.doesNotMatch(r.body, /CCCCCCCCCCC|yt-dlp/);
});

test("the access token gates both routes (header, wrong token, none) and nothing runs without it", async () => {
  process.env.ACCESS_TOKEN = TOKEN;
  for (const path of [`/api/video/${VID}/subs`, `/api/video/${VID}/subs/en.vtt`]) {
    assert.equal((await call(path)).status, 401, path);
    assert.equal((await call(path, { authorization: "Bearer wrong-token-wrong-token-12345" })).status, 401, path);
    assert.equal((await call(path, { authorization: `Bearer ${TOKEN}` })).status, 200, path);
  }
  rmSync(join(tmp, "calls"), { force: true });
  resetSubs();
  clearCache();
  assert.equal((await call(`/api/video/${NOSUB}/subs`)).status, 401);
  assert.equal(fetched.length, 1, "only the authenticated vtt request fetched anything");
  assert.equal(existsSync(join(tmp, "calls")), false, "unauthenticated requests never spawn yt-dlp");
});

const callCount = () => (existsSync(join(tmp, "calls")) ? readFileSync(join(tmp, "calls"), "utf8").trim().split("\n").length : 0);

test("a failing yt-dlp is spawned once for repeated requests within 30 s (failures are remembered)", async () => {
  const a = await call(`/api/video/EEEEEEEEEEE/subs`);
  const b = await call(`/api/video/EEEEEEEEEEE/subs`);
  const c = await call(`/api/video/EEEEEEEEEEE/subs/en.vtt`);
  for (const r of [a, b, c]) assert.equal(JSON.parse(r.body).code, "bot-check");
  assert.equal(callCount(), 1);
});

test("a hung yt-dlp is killed at the timeout, releases the slot, and the failure is classified", async () => {
  process.env.SUBS_YTDLP_TIMEOUT_MS = "300";
  try {
    const t0 = Date.now();
    const r = await call(`/api/video/DDDDDDDDDDD/subs`);
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.body).code, "network");
    assert.ok(Date.now() - t0 < 4000, "killed long before the 5 s sleep ended");
    assert.equal((await call(`/api/video/${VID}/subs`)).status, 200, "the slot is free again");
  } finally {
    delete process.env.SUBS_YTDLP_TIMEOUT_MS;
  }
});

test("too many concurrent lookups overflow the queue into 503 busy, without failing the rest", async () => {
  const ids = Array.from({ length: 8 }, (_, i) => `SLOW000000${i}`);
  const rs = await Promise.all(ids.map((id) => call(`/api/video/${id}/subs`)));
  const codes = rs.map((r) => r.status).sort((a, b) => a - b);
  assert.ok(codes.includes(503), codes.join());
  assert.ok(codes.filter((c) => c === 200).length >= 5, codes.join());
  assert.equal(rs.find((r) => r.status === 503)!.headers["retry-after"], "5");
});

test("a stalled subtitle body is cut off by the timeout", async () => {
  process.env.SUBS_FETCH_TIMEOUT_MS = "300";
  try {
    fetchMode = "stall";
    const r = await call(`/api/video/${VID}/subs/en.vtt`);
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.body).code, "network");
  } finally {
    delete process.env.SUBS_FETCH_TIMEOUT_MS;
  }
});

test("an expired subtitle URL (403) is refreshed once through yt-dlp; a persistent 403 is not retried forever", async () => {
  await call(`/api/video/${VID}/subs/de.vtt`);
  assert.equal(callCount(), 1);
  resetSubs();
  fetched = [];
  fetchMode = "403once";
  const ok = await call(`/api/video/${VID}/subs/en.vtt`);
  assert.equal(ok.status, 200);
  assert.equal(callCount(), 2, "yt-dlp was asked again for fresh URLs");
  assert.equal(fetched.length, 2);
  resetSubs();
  fetchMode = "403";
  const bad = await call(`/api/video/${VID}/subs/en.vtt`);
  assert.equal(bad.status, 502);
  assert.equal(callCount(), 3, "one refresh only");
});

test("concurrent requests for one track share a single download", async () => {
  const rs = await Promise.all([1, 2, 3, 4].map(() => call(`/api/video/${VID}/subs/de.vtt`)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(fetched.length, 1);
});

test("?pref= keeps the saved language in the list and is validated", async () => {
  const r = await call(`/api/video/${VID}/subs?pref=fr`);
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.body).tracks.map((t: { lang: string }) => t.lang).slice(0, 3), ["en", "de", "fr"]);
  assert.equal((await call(`/api/video/${VID}/subs?pref=../x`)).status, 400);
  assert.equal((await call(`/api/video/${VID}/subs?pref=${"a".repeat(40)}`)).status, 400);
});

test("an empty result is kept 10 minutes, one with tracks 1 hour (fake clock)", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  await call(`/api/video/${NOSUB}/subs/en.vtt`);
  await call(`/api/video/${VID}/subs/ja.vtt`);
  assert.equal(callCount(), 2);
  t.mock.timers.tick(9 * 60_000);
  await call(`/api/video/${NOSUB}/subs/en.vtt`);
  await call(`/api/video/${VID}/subs/ja.vtt`);
  assert.equal(callCount(), 2, "both still remembered after 9 minutes");
  t.mock.timers.tick(2 * 60_000); // 11 minutes
  await call(`/api/video/${NOSUB}/subs/en.vtt`);
  assert.equal(callCount(), 3, "the empty result expired");
  await call(`/api/video/${VID}/subs/ja.vtt`);
  assert.equal(callCount(), 3, "the one with tracks did not");
  t.mock.timers.tick(55 * 60_000); // 66 minutes
  await call(`/api/video/${VID}/subs/ja.vtt`);
  assert.equal(callCount(), 4);
});
