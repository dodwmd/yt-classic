import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { clearCache } from "./cache.ts";
import { killChildren } from "./yt/dlp.ts";

const CHANNEL = "UC" + "a".repeat(22);
const VID = "AAAAAAAAAAA";

let server: Server;
let port = 0;
let tmp = "";
const realFetch = globalThis.fetch;

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
  rmSync(process.env.PIDFILE!, { force: true });
  delete process.env.FAKE_RESOLVE_SLEEP;
  delete process.env.ALLOWED_HOSTS;
  process.env.FFMPEG_BIN = join(tmp, "ffmpeg");
});

function get(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
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
  assert.equal((await get("/watch?v=bad")).status, 400);
  assert.equal((await get("/channel/bad")).status, 400);
  assert.equal((await get("/stream/bad")).status, 400);
  assert.equal((await get("/results?search_query=" + "x".repeat(300))).status, 400);
  assert.equal((await get("/results?search_query=")).status, 302);
});

test("search results are HTML-escaped and script-free", async () => {
  const r = await get("/results?search_query=nix");
  assert.equal(r.status, 200);
  assert.ok(r.body.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(!r.body.includes("<script"));
});

test("host allow-list rejects unknown hosts", async () => {
  process.env.ALLOWED_HOSTS = "good.example";
  assert.equal((await get("/")).status, 421);
  assert.equal((await get("/healthz")).status, 200);
});

test("cross-site POSTs are refused, same-origin and non-browser ones work", async () => {
  const body = `id=${CHANNEL}`;
  const form = { "content-type": "application/x-www-form-urlencoded" };
  assert.equal((await get("/subscribe", { method: "POST", body, headers: { ...form, origin: "http://evil.example" } })).status, 403);
  assert.equal((await get("/subscribe", { method: "POST", body, headers: { ...form, "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await get("/subscribe", { method: "POST", body, headers: { ...form, origin: `http://127.0.0.1:${port}` } })).status, 303);
  assert.equal((await get("/unsubscribe", { method: "POST", body, headers: form })).status, 303); // curl-style: no Origin
  assert.equal((await get("/subscribe", { method: "POST", body: "id=nope", headers: form })).status, 400);
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
