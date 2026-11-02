import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import { clearCache } from "../cache.ts";
import { getDb } from "../db.ts";
import { resetCommentQuota } from "../commentquota.ts";
import { plainText } from "./comments.ts";

const VID = "dQw4w9WgXcQ";
const OFF = "offOffOff01";
const GONE = "goneGone001";
const T1 = "UgxAAAAAAAAAAAAAAAAAAAAAAAAA";
const T2 = "UgzBBBBBBBBBBBBBBBBBBBBBBBBB";
const CHAN = "UC" + "a".repeat(22);
const TOKEN = "comments-test-access-token-0123456789";
const KEY = "secret-api-key-comments";

let server: Server;
let port = 0;
let tmp = "";
const realFetch = globalThis.fetch;
let calls: URL[] = [];
let mode = "normal";

/** Shapes follow the real Data API: commentThreads.list items hold snippet.topLevelComment; comments.list items are comments. */
const comment = (id: string, over: Record<string, unknown> = {}) => ({
  kind: "youtube#comment", etag: "x", id,
  snippet: {
    authorDisplayName: "@Alice", authorProfileImageUrl: "https://yt3.ggpht.com/a=s48", authorChannelUrl: "http://www.youtube.com/channel/" + CHAN,
    authorChannelId: { value: CHAN }, videoId: VID, textDisplay: "hello", canRate: true, viewerRating: "none",
    likeCount: 7, publishedAt: "2024-05-01T10:00:00Z", updatedAt: "2024-05-01T10:00:00Z", ...over,
  },
});
const thread = (id: string, over: Record<string, unknown> = {}, replies = 0) => ({
  kind: "youtube#commentThread", etag: "x", id,
  snippet: { channelId: CHAN, videoId: VID, topLevelComment: comment(id, over), canReply: true, totalReplyCount: replies, isPublic: true },
});

function upstream(url: URL): { status: number; body: unknown } {
  const q = url.searchParams;
  const p = url.pathname.replace("/youtube/v3/", "");
  if (mode === "down") return { status: 500, body: { error: { message: `boom ${KEY}` } } };
  if (p === "commentThreads") {
    const v = q.get("videoId");
    if (v === OFF) return { status: 403, body: { error: { code: 403, message: "The video identified by the videoId parameter has disabled comments.", errors: [{ reason: "commentsDisabled", domain: "youtube.commentThread" }] } } };
    if (v === GONE) return { status: 404, body: { error: { code: 404, message: "The video identified by the videoId parameter could not be found.", errors: [{ reason: "videoNotFound" }] } } };
    if (mode === "badtoken") return { status: 400, body: { error: { code: 400, message: "bad token", errors: [{ reason: "invalidPageToken" }] } } };
    if (mode === "quota") return { status: 403, body: { error: { code: 403, message: "exceeded your quota", errors: [{ reason: "quotaExceeded" }] } } };
    if (mode === "empty") return { status: 200, body: { kind: "youtube#commentThreadListResponse", pageInfo: { totalResults: 0, resultsPerPage: 20 }, items: [] } };
    if (q.get("pageToken") === "PAGE2") return { status: 200, body: { pageInfo: { totalResults: 1, resultsPerPage: 20 }, items: [thread(T2, { textOriginal: "second", textDisplay: "second" })] } };
    return {
      status: 200,
      body: {
        kind: "youtube#commentThreadListResponse", nextPageToken: "PAGE2", pageInfo: { totalResults: 3, resultsPerPage: 20 },
        items: [
          thread(T1, { textDisplay: "Great & fun <3 https://example.com/x\nline two a<b and c>d <div> &amp; \u{1F600} \u{1F44D} 1\u200b2", textOriginal: undefined, authorDisplayName: "Bob\u202e \u200bCo\ufeff", authorProfileImageUrl: "http://insecure.example/a.jpg" }, 3),
          thread("Ugx" + "D".repeat(20), { textDisplay: "avatar on a foreign host", authorProfileImageUrl: "https://evil.example/a.jpg" }),
          thread("Ugx" + "E".repeat(20), { textDisplay: "avatar with credentials", authorProfileImageUrl: "https://yt3.ggpht.com@evil.example/a.jpg" }),
          thread("Ugx" + "F".repeat(20), { textDisplay: "avatar ytimg", authorProfileImageUrl: "https://i.ytimg.com/a.jpg" }),
          thread("bad id with spaces <script>", { textDisplay: "dropped: invalid id" }),
          thread("Ugx" + "C".repeat(20), { textDisplay: "x".repeat(6000), authorDisplayName: "N".repeat(300), authorChannelId: { value: "not-a-channel" }, likeCount: -5, updatedAt: "2024-06-01T10:00:00Z" }),
          { id: "x", snippet: {} },
          null,
        ],
      },
    };
  }
  if (p === "comments") {
    const parent = q.get("parentId");
    if (parent === T2) return { status: 200, body: { items: [] } };
    return {
      status: 200,
      body: {
        nextPageToken: q.get("pageToken") ? undefined : "RPAGE2",
        items: [comment(`${parent}.r1`, { textDisplay: "reply & one", parentId: parent }), comment("bad/../id.x", { textDisplay: "dropped" }), comment(`${parent}.r2`, { textDisplay: "reply two" })],
      },
    };
  }
  return { status: 404, body: {} };
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "yt-comments-"));
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
  resetCommentQuota();
  delete process.env.COMMENT_UNITS_MAX;
  delete process.env.COMMENT_REQUESTS_PER_HOUR;
});

function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; json: any; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers, json: (() => { try { return JSON.parse(body); } catch { return null; } })() }));
    });
    req.on("error", reject);
    req.end();
  });
}
const quiet = async <T>(f: () => Promise<T>) => {
  const e = console.error;
  console.error = () => {};
  try { return await f(); } finally { console.error = e; }
};

test("threads: plain text only (tags stripped, entities decoded once, emoji kept), validated fields, bad ids dropped", async () => {
  const r = await get(`/api/video/${VID}/comments`);
  assert.equal(r.status, 200);
  assert.equal(r.json.nextPageToken, "PAGE2");
  assert.equal(r.json.items.length, 5, "the invalid ids and null entries are dropped");
  const [a, d, e, f, b] = r.json.items;
  assert.equal(d.authorThumb, undefined, "an avatar from a host the CSP does not allow");
  assert.equal(e.authorThumb, undefined, "credentials in the avatar URL");
  assert.equal(f.authorThumb, "https://i.ytimg.com/a.jpg");
  assert.equal(a.id, T1);
  assert.equal(a.text, "Great & fun <3 https://example.com/x\nline two a<b and c>d <div> &amp; \u{1F600} \u{1F44D} 12", "plain text stays as written; invisible characters go");
  assert.equal(a.author, "Bob Co", "bidi override, zero-width space and BOM removed");
  assert.equal(a.authorChannelId, CHAN);
  assert.equal(a.authorThumb, undefined, "http thumbnails are not passed on");
  assert.equal(a.likeCount, 7);
  assert.equal(a.replyCount, 3);
  assert.equal(a.publishedAt, "2024-05-01T10:00:00Z");
  assert.equal(a.updatedAt, undefined, "updatedAt only when it differs");
  assert.equal(b.text.length, 5000);
  assert.equal(b.author.length, 100);
  assert.equal(b.authorChannelId, undefined);
  assert.equal(b.likeCount, 0);
  assert.equal(b.updatedAt, "2024-06-01T10:00:00Z");
  assert.deepEqual(Object.keys(a).sort(), ["author", "authorChannelId", "id", "likeCount", "publishedAt", "replyCount", "text"]);
  assert.equal(r.json.items[0].authorThumb, undefined);
  const q = calls[0].searchParams;
  assert.deepEqual([q.get("part"), q.get("videoId"), q.get("maxResults"), q.get("order"), q.get("textFormat")], ["snippet", VID, "20", "relevance", "plainText"]);
});

test("order=new asks for time order; bad orders are refused; pageToken is forwarded; pages are cached", async () => {
  const r = await get(`/api/video/${VID}/comments?order=new&pageToken=PAGE2`);
  assert.equal(r.status, 200);
  assert.equal(r.json.items[0].text, "second");
  assert.equal(r.json.nextPageToken, undefined);
  assert.equal(calls[0].searchParams.get("order"), "time");
  assert.equal(calls[0].searchParams.get("pageToken"), "PAGE2");
  await get(`/api/video/${VID}/comments?order=new&pageToken=PAGE2`);
  assert.equal(calls.length, 1, "repeat is served from the cache");
  await get(`/api/video/${VID}/comments?order=top&pageToken=PAGE2`);
  assert.equal(calls.length, 2, "another order is another page");
  assert.equal((await get(`/api/video/${VID}/comments?order=hot`)).status, 400);
  assert.equal(calls.length, 2);
});

test("a video without comments is an empty list, not an error", async () => {
  mode = "empty";
  const r = await get(`/api/video/${VID}/comments`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { items: [] });
});

test("comments turned off: 403 comments-disabled with the table's message, and remembered", async () => {
  const r = await get(`/api/video/${OFF}/comments`);
  assert.equal(r.status, 403);
  assert.equal(r.json.code, "comments-disabled");
  assert.equal(r.json.retryable, false);
  assert.equal(r.json.error, "Comments are turned off for this video.");
  assert.ok(!r.body.includes(KEY) && !r.body.includes("videoId"));
  assert.equal((await get(`/api/video/${OFF}/comments`)).status, 403);
  assert.equal(calls.length, 1, "the answer is cached: reopening costs no units");
});

test("a removed video is a classified 404; quota exhaustion upstream is a rate limit", async () => {
  const gone = await quiet(() => get(`/api/video/${GONE}/comments`));
  assert.equal(gone.status, 404);
  assert.equal(gone.json.code, "removed");
  mode = "quota";
  const q = await quiet(() => get(`/api/video/${VID}/comments`));
  assert.equal(q.status, 429);
  assert.equal(q.json.code, "rate-limited");
  assert.ok(q.headers["retry-after"]);
});

test("replies: flat list, parent forwarded, ids validated, token paging", async () => {
  const r = await get(`/api/comments/${T1}/replies`);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.items.map((c: any) => [c.id, c.text, c.replyCount]), [[`${T1}.r1`, "reply & one", 0], [`${T1}.r2`, "reply two", 0]]);
  assert.equal(r.json.nextPageToken, "RPAGE2");
  assert.equal(calls[0].pathname, "/youtube/v3/comments");
  assert.equal(calls[0].searchParams.get("parentId"), T1);
  assert.equal(calls[0].searchParams.get("maxResults"), "20");
  const r2 = await get(`/api/comments/${T1}/replies?pageToken=RPAGE2`);
  assert.equal(r2.json.nextPageToken, undefined);
  assert.equal(calls[1].searchParams.get("pageToken"), "RPAGE2");
  assert.deepEqual((await get(`/api/comments/${T2}/replies`)).json, { items: [] });
});

test("bad video ids, comment ids, tokens and routes are refused before any upstream call", async () => {
  const bad = [
    "/api/video/short/comments", `/api/video/${VID}%2F..%2Fx/comments`, `/api/video/${VID}x/comments`,
    "/api/comments/short/replies", `/api/comments/${T1}.r1/replies`, `/api/comments/${T1}%3Fkey%3D1/replies`, `/api/comments/${"U".repeat(81)}/replies`,
    ...["a%20b", "x%2Fy", "a.b", "a%3Fb", "%3Cscript%3E", "x".repeat(121)].flatMap((t) => [`/api/video/${VID}/comments?pageToken=${t}`, `/api/comments/${T1}/replies?pageToken=${t}`]),
  ];
  for (const p of bad) assert.equal((await get(p)).status, 400, p);
  assert.equal(calls.length, 0);
  assert.equal((await get(`/api/comments/${T1}/replies?pageToken=${"x".repeat(120)}`)).status, 200);
  for (const p of [`/api/video/${VID}/comments/x`, `/api/comments/${T1}`, `/api/comments/${T1}/replies/x`]) assert.notEqual((await get(p)).status, 200, p);
});

test("minted page tokens cannot cost more than the daily unit budget; cached pages are free", async () => {
  process.env.COMMENT_UNITS_MAX = "5";
  const statuses: number[] = [];
  for (let i = 0; i < 9; i++) statuses.push((await get(`/api/video/${VID}/comments?pageToken=minted${i}`)).status);
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429, 429, 429, 429]);
  assert.equal(calls.length, 5, "nothing past the budget reaches the Data API");
  const r = await get(`/api/comments/${T1}/replies`);
  assert.equal(r.status, 429);
  assert.equal(r.json.code, "rate-limited");
  assert.ok(Number(r.headers["retry-after"]) >= 1);
  assert.equal((await get(`/api/video/${VID}/comments?pageToken=minted0`)).status, 200, "a cached page still works");
});

test("hourly request cap answers 429 with Retry-After, cached or not", async () => {
  process.env.COMMENT_REQUESTS_PER_HOUR = "3";
  for (let i = 0; i < 3; i++) assert.equal((await get(`/api/video/${VID}/comments`)).status, 200);
  assert.equal(calls.length, 1);
  const r = await get(`/api/video/${VID}/comments`);
  assert.equal(r.status, 429);
  assert.equal(r.json.code, "rate-limited");
  assert.ok(Number(r.headers["retry-after"]) >= 1 && Number(r.headers["retry-after"]) <= 3600);
});

test("upstream failures give the generic error JSON and never leak the key", async () => {
  mode = "down";
  for (const p of [`/api/video/${VID}/comments`, `/api/comments/${T1}/replies`]) {
    const r = await quiet(() => get(p));
    assert.equal(r.status, 502, p);
    assert.ok(!r.body.includes(KEY) && !r.body.includes("boom"), p);
  }
  mode = "normal";
  const ok = await get(`/api/video/${VID}/comments`);
  assert.ok(!ok.body.includes(KEY));
  assert.ok(calls.every((u) => u.searchParams.get("key") === KEY), "the key only goes to the Data API");
});

test("both routes are behind the access token", async () => {
  process.env.ACCESS_TOKEN = TOKEN;
  try {
    for (const p of [`/api/video/${VID}/comments`, `/api/comments/${T1}/replies`]) assert.equal((await get(p)).status, 401, p);
    assert.equal(calls.length, 0, "nothing reached the Data API");
    assert.equal((await get(`/api/video/${VID}/comments`, { authorization: `Bearer ${TOKEN}` })).status, 200);
    assert.equal((await get(`/api/comments/${T1}/replies`, { authorization: `Bearer ${TOKEN}` })).status, 200);
  } finally {
    delete process.env.ACCESS_TOKEN;
  }
});

test("plainText: plain text is not treated as HTML; control and invisible characters go", () => {
  assert.equal(plainText("a<b and c>d"), "a<b and c>d");
  assert.equal(plainText("<div>x</div> &amp; &lt;"), "<div>x</div> &amp; &lt;", "no tag stripping, no entity decoding");
  assert.equal(plainText("a\u0000b\u202ec\r\nd"), "abc\nd");
  assert.equal(plainText("a\u200b\u200e\u200f\u061c\ufeff\u{e0041}b"), "ab");
  assert.equal(plainText("\u{1F468}\u200d\u{1F469}"), "\u{1F468}\u200d\u{1F469}", "the joiner of emoji sequences stays");
  assert.equal(plainText(undefined), "");
  assert.equal(plainText(42), "");
  assert.equal(plainText("\u{1F600}".repeat(6000)).length, 5000);
  assert.equal(plainText("x".repeat(4999) + "\u{1F600}").length, 4999, "no lone surrogate at the cut");
  assert.equal(plainText("\u200b".repeat(30_000) + "x"), "", "only the first 20,000 units are looked at");
});

test("comments off is remembered for the hour: no second upstream call, no budget, no hourly slot", async () => {
  process.env.COMMENT_REQUESTS_PER_HOUR = "3";
  const real = Date.now;
  try {
    assert.equal((await get(`/api/video/${OFF}/comments`)).status, 403);
    assert.equal(calls.length, 1);
    for (const q of ["", "?order=new", "?pageToken=abc"]) {
      const r = await get(`/api/video/${OFF}/comments${q}`);
      assert.equal(r.status, 403, q);
      assert.equal(r.json.code, "comments-disabled");
    }
    assert.equal(calls.length, 1, "both orders and any token share the answer");
    // The in-memory copy is gone (a restart): the persisted one answers.
    clearCache();
    assert.equal((await get(`/api/video/${OFF}/comments?order=new`)).status, 403);
    assert.equal(calls.length, 1);
    assert.equal((await get(`/api/video/${VID}/comments`)).status, 200, "known-off requests used none of the 3 hourly slots");
    Date.now = () => real() + 5 * 60_000 + 61_000; // past the 1-minute negative-cache time and 5 minutes on
    assert.equal((await get(`/api/video/${OFF}/comments`)).status, 403);
    assert.equal(calls.length, 2, "only the VID call: still no second upstream call for the off video");
    Date.now = () => real() + 61 * 60_000;
    resetCommentQuota();
    assert.equal((await get(`/api/video/${OFF}/comments`)).status, 403);
    assert.equal(calls.length, 3, "after an hour it is asked again");
  } finally {
    Date.now = real;
  }
});

test("an invalid page token from the Data API is a friendly retryable error", async () => {
  mode = "badtoken";
  const r = await quiet(() => get(`/api/video/${VID}/comments?pageToken=old`));
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "stale-page");
  assert.equal(r.json.retryable, true);
});

// The Android app's JVM tests replay these files (android/app/src/test/resources/comments-*.json). They must stay what this
// backend really answers: this test fails when they drift, and UPDATE_FIXTURES=1 rewrites them.
test("the Android fixtures are exactly what the backend answers", async () => {
  const dir = new URL("../../../android/app/src/test/resources/", import.meta.url);
  const cases: Array<[string, string, string]> = [
    ["comments-page1", `/api/video/${VID}/comments`, "normal"],
    ["comments-page2", `/api/video/${VID}/comments?pageToken=PAGE2`, "normal"],
    ["comments-replies", `/api/comments/${T1}/replies`, "normal"],
    ["comments-disabled", `/api/video/${OFF}/comments`, "normal"],
    ["comments-empty", `/api/video/${VID}/comments?order=new`, "empty"],
  ];
  for (const [name, path, m] of cases) {
    clearCache();
    getDb().exec("DELETE FROM cache");
    resetCommentQuota();
    mode = m;
    const r = await quiet(() => get(path));
    const text = JSON.stringify(r.json, null, 2) + "\n";
    if (process.env.UPDATE_FIXTURES) writeFileSync(new URL(`${name}.json`, dir), text);
    assert.equal(readFileSync(new URL(`${name}.json`, dir), "utf8"), text, `${name}.json is out of date: run UPDATE_FIXTURES=1 npm test`);
  }
});
