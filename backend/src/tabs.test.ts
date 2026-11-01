import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { clearCache } from "./cache.ts";
import { getDb } from "./db.ts";
import { MAX_SCAN_PAGES, descriptionLinks } from "./yt/api.ts";

const CH = "UC" + "b".repeat(22);
const EMPTY = "UC" + "e".repeat(22);
const OTHER = "UC" + "o".repeat(22);
const PL = "PL" + "x".repeat(16);
const FOREIGN = "PL" + "f".repeat(16);
const TOKEN = "tabs-test-access-token-0123456789";
const KEY = "secret-api-key-tabs";

let server: Server;
let port = 0;
let tmp = "";
const realFetch = globalThis.fetch;
let calls: URL[] = [];
let mode = "normal";

const vid = (n: number) => `V${String(n).padStart(10, "0")}`;
const iso = (s: number) => `PT${Math.floor(s / 60)}M${s % 60}S`;
/** The channel's uploads, newest first: every 5th is a short (30 s), every 7th a live stream, the rest 10 minutes. */
const kindOf = (n: number) => (n % 7 === 0 ? "live" : n % 5 === 0 ? "short" : "video");
const TOTAL = 120;

function upstream(url: URL): { status: number; body: unknown } {
  const q = url.searchParams;
  const p = url.pathname.replace("/youtube/v3/", "");
  if (mode === "down") return { status: 500, body: { error: { message: `boom ${KEY}` } } };
  if (p === "channels") {
    const id = q.get("id");
    if (id === OTHER) return { status: 200, body: { items: [] } };
    return {
      status: 200,
      body: {
        kind: "youtube#channelListResponse",
        items: [{
          kind: "youtube#channel", id,
          snippet: { title: "Tab Chan", description: "Hello\nSite: https://example.com/a, and http://example.org/b.\nbad javascript:alert(1) https://example.com/a", customUrl: "@tabchan", publishedAt: "2015-03-04T05:06:07Z", country: "AU", thumbnails: { default: { url: "https://yt3.ggpht.com/t.jpg" } } },
          statistics: { viewCount: "123456", subscriberCount: "7890", hiddenSubscriberCount: mode === "hidden", videoCount: "120" },
          brandingSettings: { channel: { title: "Tab Chan" }, image: { bannerExternalUrl: "https://yt3.ggpht.com/b.jpg" } },
        }],
      },
    };
  }
  if (p === "playlists") {
    if (q.get("id")) {
      const id = q.get("id");
      if (id === PL) return { status: 200, body: { items: [{ id, snippet: { channelId: CH, title: "Mix tape" } }] } };
      if (id === FOREIGN) return { status: 200, body: { items: [{ id, snippet: { channelId: OTHER, title: "Not yours" } }] } };
      return { status: 200, body: { items: [] } };
    }
    if (q.get("channelId") === EMPTY) return { status: 200, body: { kind: "youtube#playlistListResponse", pageInfo: { totalResults: 0 }, items: [] } };
    const page = q.get("pageToken") === "P2" ? 2 : 1;
    const items = [1, 2].map((i) => ({
      kind: "youtube#playlist", id: `PL${page}${i}`.padEnd(18, "z"),
      snippet: { publishedAt: "2020-01-01T00:00:00Z", channelId: CH, title: `List ${page}.${i}`, description: "d", thumbnails: { medium: { url: `https://i.ytimg.com/vi/x${i}/mqdefault.jpg` } } },
      contentDetails: { itemCount: 3 * i },
    }));
    return { status: 200, body: { items, ...(page === 1 ? { nextPageToken: "P2" } : {}) } };
  }
  if (p === "playlistItems") {
    const pid = q.get("playlistId") ?? "";
    if (pid === "UU" + EMPTY.slice(2)) return { status: 404, body: { error: { message: "playlistNotFound", errors: [{ reason: "playlistNotFound" }] } } };
    const mk = (n: number, title = `Video ${n}`) => ({
      kind: "youtube#playlistItem",
      snippet: { publishedAt: "2024-01-01T00:00:00Z", channelId: CH, title, description: "", thumbnails: title.endsWith("video") ? {} : { medium: { url: `https://i.ytimg.com/vi/${vid(n)}/mqdefault.jpg` } }, videoOwnerChannelTitle: "Tab Chan", videoOwnerChannelId: CH, resourceId: { kind: "youtube#video", videoId: vid(n) } },
    });
    if (pid === PL) {
      const items = [mk(1), mk(2, "Private video"), mk(3, "Deleted video"), mk(4)];
      return { status: 200, body: { items, ...(q.get("pageToken") ? {} : { nextPageToken: "I2" }) } };
    }
    // Uploads: 50 a page.
    const start = q.get("pageToken") ? Number(q.get("pageToken")) : 0;
    const max = Number(q.get("maxResults"));
    const end = Math.min(start + max, TOTAL);
    const items = [];
    for (let n = start; n < end; n++) items.push(mk(n + 1));
    return { status: 200, body: { items, ...(end < TOTAL ? { nextPageToken: String(end) } : {}) } };
  }
  if (p === "videos") {
    const ids = (q.get("id") ?? "").split(",");
    assert.ok(ids.length <= 50, "videos.list takes at most 50 ids");
    const items = ids.map((id) => {
      const n = Number(id.slice(1));
      const k = kindOf(n);
      return {
        id,
        snippet: { liveBroadcastContent: k === "live" ? (n === 7 ? "live" : n === 14 ? "upcoming" : "none") : "none" },
        contentDetails: { duration: k === "short" ? iso(30) : iso(600) },
        ...(k === "live" ? { liveStreamingDetails: { actualStartTime: "2024-01-01T00:00:00Z" } } : {}),
      };
    });
    return { status: 200, body: { items } };
  }
  return { status: 404, body: {} };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "yt-tabs-"));
  process.env.DATA_DIR = join(tmp, "data");
  process.env.YT_API_KEY = KEY;
  delete process.env.ACCESS_TOKEN;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (!url.pathname.startsWith("/youtube/v3/")) return realFetch(input);
    calls.push(url);
    const r = upstream(url);
    return new Response(JSON.stringify(r.body), { status: r.status });
  }) as typeof fetch;
  server = createApp();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

after(() => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  clearCache();
  getDb().exec("DELETE FROM cache");
  calls = [];
  mode = "normal";
});

function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; json: any }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() }));
    });
    req.on("error", reject);
    req.end();
  });
}
const units = () => calls.length;
const hit = (name: string) => calls.filter((u) => u.pathname.endsWith("/" + name));

test("playlists: lists the channel's public playlists, forwards the page token, caches", async () => {
  const r = await get(`/api/channel/${CH}/playlists`);
  assert.equal(r.status, 200);
  assert.equal(r.json.page.items.length, 2);
  assert.deepEqual(Object.keys(r.json.page.items[0]).sort(), ["description", "id", "itemCount", "publishedAt", "thumb", "title"]);
  assert.equal(r.json.page.items[1].itemCount, 6);
  assert.equal(r.json.page.nextPageToken, "P2");
  const before = units();
  await get(`/api/channel/${CH}/playlists`);
  assert.equal(units(), before, "second request is served from the cache");
  const r2 = await get(`/api/channel/${CH}/playlists?pageToken=P2`);
  assert.equal(r2.json.page.items[0].title, "List 2.1");
  assert.equal(r2.json.page.nextPageToken, undefined);
  assert.equal(hit("playlists").at(-1)!.searchParams.get("pageToken"), "P2");
  assert.equal(hit("playlists").at(-1)!.searchParams.get("channelId"), CH);
});

test("playlists: a channel without playlists is an empty page, an unknown channel a 404", async () => {
  const r = await get(`/api/channel/${EMPTY}/playlists`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.page.items, []);
  assert.equal((await get(`/api/channel/${OTHER}/playlists`)).status, 404);
});

test("playlist drill-down: items link to videos, private/deleted ones are dropped, foreign playlists 404", async () => {
  const r = await get(`/api/channel/${CH}/playlist/${PL}`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.playlist, { id: PL, title: "Mix tape" });
  assert.deepEqual(r.json.page.items.map((v: any) => v.id), [vid(1), vid(4)]);
  assert.equal(r.json.page.nextPageToken, "I2");
  const r2 = await get(`/api/channel/${CH}/playlist/${PL}?pageToken=I2`);
  assert.equal(r2.json.page.nextPageToken, undefined);
  assert.equal(hit("playlistItems").at(-1)!.searchParams.get("pageToken"), "I2");
  assert.equal((await get(`/api/channel/${CH}/playlist/${FOREIGN}`)).status, 404);
  assert.equal((await get(`/api/channel/${CH}/playlist/PL${"m".repeat(16)}`)).status, 404);
});

test("bad ids, tokens and routes are refused before any upstream call", async () => {
  const bad = [
    `/api/channel/bad/playlists`,
    `/api/channel/bad/about`,
    `/api/channel/${CH}/playlist/short`,
    `/api/channel/${CH}/playlist/${PL}%2F..%2Fx`,
    `/api/channel/${CH}/playlist/PL%3Fkey%3D1abcdefghij`,
    `/api/channel/${CH}/playlist/${"P".repeat(70)}`,
  ];
  for (const p of bad) assert.equal((await get(p)).status, 400, p);
  for (const t of ["playlists", "shorts", "live", "about"]) assert.equal((await get(`/api/channel/${CH}/${t}?pageToken=${"x".repeat(201)}`)).status, 400, t);
  for (const p of [`/api/channel/${CH}/nope`, `/api/channel/${CH}/playlist`, `/api/channel/${CH}/playlists/${PL}`, `/api/channel/${CH}/about/x`, `/api/channel/${CH}/shorts/x/y`]) {
    assert.equal((await get(p)).status, 404, p);
  }
  assert.equal(units(), 0);
});

test("shorts: only uploads of 61 seconds or less, never streams; pages through with the returned token", async () => {
  const r = await get(`/api/channel/${CH}/shorts`);
  assert.equal(r.status, 200);
  const ns = r.json.page.items.map((v: any) => Number(v.id.slice(1)));
  assert.ok(ns.length > 0 && ns.every((n: number) => kindOf(n) === "short"), ns.join());
  assert.ok(r.json.page.items.every((v: any) => v.durationSeconds === 30 && v.live === undefined));
  assert.ok(!ns.includes(35), "35 is both a multiple of 5 and 7: a stream, not a short");
  // 50 uploads per scan page: the first page has 10 multiples of 5 (5..50) minus the 7 streams (35) = 9... keep scanning to 12.
  const token = r.json.page.nextPageToken;
  assert.ok(token);
  const r2 = await get(`/api/channel/${CH}/shorts?pageToken=${token}`);
  assert.ok(r2.json.page.items.every((v: any) => Number(v.id.slice(1)) > 50));
  assert.equal(hit("playlistItems")[0].searchParams.get("maxResults"), "50");
  for (const c of hit("videos")) assert.ok(c.searchParams.get("id")!.split(",").length <= 50);
});

test("live: current, upcoming and finished streams are labelled", async () => {
  const r = await get(`/api/channel/${CH}/live`);
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.json.page.items.map((v: any) => [Number(v.id.slice(1)), v.live]));
  assert.equal(by[7], "live");
  assert.equal(by[14], "upcoming");
  assert.equal(by[21], "ended");
  assert.ok(Object.values(by).every((x) => x === "live" || x === "upcoming" || x === "ended"));
});

test("shorts and live share the scanned uploads: bounded cost per request, and cached", async () => {
  await get(`/api/channel/${CH}/shorts`);
  const after = units();
  assert.ok(hit("playlistItems").length <= MAX_SCAN_PAGES && hit("videos").length <= MAX_SCAN_PAGES);
  assert.ok(after <= 1 + 2 * MAX_SCAN_PAGES, `at most the channel lookup plus 2 units a scanned page, got ${after}`);
  await get(`/api/channel/${CH}/live`); // the first uploads page is already scanned
  assert.ok(units() - after <= 2 * MAX_SCAN_PAGES - 2);
  const again = units();
  await get(`/api/channel/${CH}/shorts`);
  assert.equal(units(), again, "repeat is free");
});

test("a channel with no uploads yields empty shorts and live, not an error", async () => {
  for (const t of ["shorts", "live"]) {
    const r = await get(`/api/channel/${EMPTY}/${t}`);
    assert.equal(r.status, 200, t);
    assert.deepEqual(r.json.page, { items: [] });
  }
  assert.equal(hit("videos").length, 0, "no ids, no videos.list call");
});

test("about: description, handle, join date, country, counts and links from the description", async () => {
  const r = await get(`/api/channel/${CH}/about`);
  assert.equal(r.status, 200);
  const a = r.json.about;
  assert.equal(a.customUrl, "@tabchan");
  assert.equal(a.publishedAt, "2015-03-04T05:06:07Z");
  assert.equal(a.country, "AU");
  assert.equal(a.viewCount, "123456");
  assert.equal(a.subscriberCount, "7890");
  assert.equal(a.videoCount, "120");
  assert.deepEqual(a.links, ["https://example.com/a", "http://example.org/b"]);
  assert.match(a.description, /^Hello/);
  assert.equal((await get(`/api/channel/${OTHER}/about`)).status, 404);
});

test("about: hidden subscriber counts are not reported", async () => {
  mode = "hidden";
  const a = (await get(`/api/channel/${CH}/about`)).json.about;
  assert.equal(a.subscriberCount, undefined);
  assert.equal(a.viewCount, "123456");
});

test("descriptionLinks only keeps http(s) URLs", () => {
  assert.deepEqual(descriptionLinks("a javascript:alert(1) ftp://x.y/z data:text/html,x https://ok.example/p?q=1)."), ["https://ok.example/p?q=1"]);
  assert.equal(descriptionLinks(Array.from({ length: 40 }, (_, i) => `https://e.example/${i}`).join(" ")).length, 20);
});

test("upstream failures give the generic error JSON and never leak the key", async () => {
  const ok = await get(`/api/channel/${CH}/about`);
  assert.ok(!ok.body.includes(KEY));
  mode = "down";
  clearCache();
  getDb().exec("DELETE FROM cache");
  const realErr = console.error;
  console.error = () => {};
  try {
    for (const t of ["playlists", "shorts", "live", "about", `playlist/${PL}`]) {
      const r = await get(`/api/channel/${CH}/${t}`);
      assert.equal(r.status, 502, t);
      assert.ok(typeof r.json.error === "string" && !r.body.includes(KEY) && !r.body.includes("boom"), t);
    }
  } finally {
    console.error = realErr;
  }
});

test("every tab is behind the access token", async () => {
  process.env.ACCESS_TOKEN = TOKEN;
  try {
    for (const t of ["", "/playlists", "/shorts", "/live", "/about", `/playlist/${PL}`]) {
      const r = await get(`/api/channel/${CH}${t}`);
      assert.equal(r.status, 401, t);
    }
    assert.equal(units(), 0, "nothing reached the Data API");
    const authed = await get(`/api/channel/${CH}/about`, { authorization: `Bearer ${TOKEN}` });
    assert.equal(authed.status, 200);
  } finally {
    delete process.env.ACCESS_TOKEN;
  }
});
