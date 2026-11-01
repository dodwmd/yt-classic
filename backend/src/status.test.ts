import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { closeDb } from "./db.ts";
import { FAILING_AFTER, classifyFailure, resetStatusForTests, statusPage } from "./status.ts";

let server: Server;
let base = "";
let tmp = "";

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "yt-status-"));
  process.env.DATA_DIR = join(tmp, "data");
  process.env.YT_API_KEY = "test-key";
  const script = (name: string, body: string) => {
    const p = join(tmp, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  // Fails (like a bot check, mentioning the URL and a path) while the marker file "fail" exists.
  process.env.YTDLP_BIN = script(
    "yt-dlp",
    `[ "$1" = "--version" ] && { echo 2099.01.02; exit 0; }
if [ -e "${tmp}/unavail" ]; then echo "ERROR: [youtube] SECRETVID01: Video unavailable. This video is private" >&2; exit 1; fi
if [ -e "${tmp}/fail" ]; then echo "ERROR: [youtube] $(basename "$0"): Sign in to confirm you're not a bot https://www.youtube.com/watch?v=SECRETVID01 /home/secret/path" >&2; exit 1; fi
echo https://rr1.googlevideo.com/SECRET-STREAM-URL`,
  );
  process.env.FFMPEG_BIN = script("ffmpeg", `echo "ffmpeg version 9.9.9-test Copyright (c) the FFmpeg developers"`);
  server = createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
  closeDb(true);
  rmSync(tmp, { recursive: true, force: true });
});

const setFailing = (on: boolean) => (on ? writeFileSync(join(tmp, "fail"), "") : rmSync(join(tmp, "fail"), { force: true }));
// HEAD /stream/:id resolves through yt-dlp but starts no ffmpeg.
const resolve = (id: string) => fetch(`${base}/stream/${id}`, { method: "HEAD" });
const status = async () => (await fetch(`${base}/api/status`)).json() as Promise<any>;

test("fresh instance: shape, versions, no counts", async () => {
  const s = await status();
  assert.equal(s.health, "ok");
  assert.deepEqual(s.ytdlp, { version: "2099.01.02", present: true });
  assert.deepEqual(s.ffmpeg, { present: true, version: "9.9.9-test" });
  assert.equal(s.node, process.version);
  assert.equal(s.resolves.ok, 0);
  assert.equal(s.resolves.lastSuccess, null);
  assert.equal(s.resolves.lastFailure, null);
  assert.equal(s.cache.ok, true);
  assert.deepEqual(Object.keys(s.streams), ["active", "started", "finished", "failed"]);
  assert.deepEqual(Object.keys(s.dataApi), ["unitsToday", "searchFallbackRemaining"]);
  assert.ok(s.cache.hits >= 0 && s.cache.misses >= 0 && s.cache.dbBytes > 0);
  assert.ok(Number.isInteger(s.uptimeSeconds) && s.uptimeSeconds >= 0);
});

test("health goes ok -> degraded -> failing -> ok, and nothing leaks", async () => {
  assert.equal((await resolve("AAAAAAAAAAA")).status, 200);
  let s = await status();
  assert.equal(s.resolves.ok, 1);
  assert.ok(Date.parse(s.resolves.lastSuccess.at) > 0);
  assert.deepEqual(Object.keys(s.resolves.lastSuccess), ["at"], "no video id in the response");
  assert.ok(!JSON.stringify(s).includes("AAAAAAAAAAA"));
  assert.equal(s.health, "ok");

  setFailing(true);
  for (let i = 1; i <= FAILING_AFTER; i++) {
    assert.equal((await resolve(`BBBBBBBBBB${i}`)).status, 502);
    s = await status();
    assert.equal(s.resolves.failed, i);
    assert.equal(s.health, i < FAILING_AFTER ? "degraded" : "failing");
  }
  assert.equal(s.resolves.lastFailure.reason, "bot-check");
  const raw = JSON.stringify(s);
  for (const secret of ["SECRET", "googlevideo", "youtube.com", "/home", tmp, "yt-dlp\""]) assert.ok(!raw.includes(secret), `leaked ${secret}`);

  setFailing(false);
  assert.equal((await resolve("CCCCCCCCCCC")).status, 200);
  s = await status();
  assert.equal(s.health, "ok");
  assert.equal(s.resolves.consecutiveFailures, 0);
  assert.ok(s.resolves.lastFailure, "the last failure stays on record");
});

test("last success and failure survive a restart; counters restart", async () => {
  setFailing(true);
  await resolve("DDDDDDDDDDD");
  await resolve("EEEEEEEEEEE");
  setFailing(false);
  closeDb(); // process gone ...
  resetStatusForTests(); // ... and a new one starts with empty memory
  const s = await status();
  assert.equal(s.resolves.ok, 0);
  assert.equal(s.resolves.failed, 0);
  assert.ok(s.resolves.lastSuccess.at);
  assert.equal(s.resolves.lastFailure.reason, "bot-check");
  assert.equal(s.resolves.consecutiveFailures, 2); // the two failures are newer than the success
  assert.equal(s.health, "degraded");
});

test("user-caused failures (private, removed, age-restricted) are counted but never make health degraded or failing", async () => {
  setFailing(false);
  assert.equal((await resolve("GGGGGGGGGG0")).status, 200);
  const before = await status();
  writeFileSync(join(tmp, "unavail"), "");
  for (let i = 1; i <= FAILING_AFTER + 2; i++) assert.equal((await resolve(`GGGGGGGGGG${i}`)).status, 404);
  let s = await status();
  assert.equal(s.resolves.failed, before.resolves.failed + FAILING_AFTER + 2);
  assert.equal(s.resolves.lastFailure.reason, "unavailable");
  assert.equal(s.resolves.consecutiveFailures, 0);
  assert.equal(s.health, "ok");
  // ... and they do not hide or reset a genuine streak: 2 real failures, then unavailable ones keep it at 2
  rmSync(join(tmp, "unavail"));
  setFailing(true);
  await resolve("HHHHHHHHHH1");
  await resolve("HHHHHHHHHH2");
  writeFileSync(join(tmp, "unavail"), "");
  await resolve("HHHHHHHHHH3");
  s = await status();
  assert.equal(s.resolves.consecutiveFailures, 2);
  assert.equal(s.health, "degraded");
  rmSync(join(tmp, "unavail"));
  setFailing(false);
  assert.equal((await resolve("HHHHHHHHHH4")).status, 200); // leave a clean slate for the next test
});

test("a persisted run of failures with no success since still reads as failing after a restart", async () => {
  setFailing(true);
  for (const id of ["FFFFFFFFFF1", "FFFFFFFFFF2", "FFFFFFFFFF3"]) await resolve(id);
  closeDb();
  resetStatusForTests();
  const s = await status();
  assert.equal(s.health, "failing");
  assert.equal(s.resolves.consecutiveFailures, 3);
  setFailing(false);
});

test("a missing yt-dlp reports degraded, not a crash", async () => {
  const saved = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = join(tmp, "nope");
  resetStatusForTests();
  closeDb();
  process.env.DATA_DIR = join(tmp, "data2");
  const s = await status();
  assert.deepEqual(s.ytdlp, { version: null, present: false });
  assert.equal(s.health, "degraded");
  process.env.YTDLP_BIN = saved;
});

test("/status is a script-free HTML page with the same fields, escaped", async () => {
  resetStatusForTests(); // the previous test left a cached "no yt-dlp" version behind
  const res = await fetch(`${base}/status`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /^text\/html/);
  const html = await res.text();
  assert.match(html, /health: (ok|degraded|failing)/);
  assert.match(html, /ytdlp\.version: 2099\.01\.02/);
  assert.ok(!/<script|videoId/i.test(html));
  assert.equal(statusPage({ x: "<b>&\"'" }).includes("<b>"), false);
  assert.ok(statusPage({ x: "<b>" }).includes("x: &#60;b&#62;"));
});

test("with ACCESS_TOKEN set, /api/status needs it and /status sends visitors to the login page", async () => {
  const token = "status-test-token-0123456789";
  process.env.ACCESS_TOKEN = token;
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    const page = await fetch(`${base}/status`, { redirect: "manual" });
    assert.equal(page.status, 303);
    assert.equal(page.headers.get("location"), "/login?next=%2Fstatus");
    assert.equal((await fetch(`${base}/api/status`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    delete process.env.ACCESS_TOKEN;
  }
});

test("host allow-list applies to /api/status and /status", async () => {
  process.env.ALLOWED_HOSTS = "only.example";
  try {
    assert.equal((await fetch(`${base}/api/status`)).status, 421);
    assert.equal((await fetch(`${base}/status`)).status, 421);
  } finally {
    delete process.env.ALLOWED_HOSTS;
  }
});

test("classifyFailure uses fixed labels only", () => {
  assert.equal(classifyFailure({ code: "ENOENT" }), "not-installed");
  assert.equal(classifyFailure({ killed: true }), "timeout");
  assert.equal(classifyFailure({ stderr: "HTTP Error 429: Too Many Requests" }), "rate-limited");
  assert.equal(classifyFailure({ stderr: "Video unavailable" }), "unavailable");
  assert.equal(classifyFailure({ stderr: "ERROR: Sign in to confirm your age. This video may be inappropriate for some users." }), "unavailable");
  assert.equal(classifyFailure({ stderr: "ERROR: Sign in to confirm you're not a bot" }), "bot-check");
  assert.equal(classifyFailure({ stderr: "ERROR: Sign in to confirm you\u2019re not a bot" }), "bot-check"); // curly apostrophe, as yt-dlp prints it
  assert.equal(classifyFailure({ stderr: "ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>" }), "network");
  assert.equal(classifyFailure(new Error("yt-dlp returned no stream URL")), "no-url");
  assert.equal(classifyFailure(new Error("weird")), "other");
});
