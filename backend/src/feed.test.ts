import { test } from "node:test";
import assert from "node:assert/strict";
import { SHORT_MAX, decodeCursor, encodeCursor, feedPage, parseFilter, type FeedDeps, type FeedFilter } from "./feed.ts";
import { DEFAULT_PREFS } from "./prefs.ts";
import { mergeFeeds, parseFeed, type FeedItem } from "./yt/rss.ts";
import type { VideoFacts } from "./yt/api.ts";

const ch = (c: string) => "UC" + c.repeat(22);
const vid = (n: number) => `v${String(n).padStart(10, "0")}`;
const item = (n: number, over: Partial<FeedItem> = {}): FeedItem => ({
  id: vid(n), title: `t${n}`, channelId: ch("a"), channelTitle: "A", publishedAt: new Date(Date.UTC(2026, 0, 1) + (1000 - n) * 60_000).toISOString(), ...over,
});
const none: FeedFilter = { hideWatched: false, shorts: "show", live: "show" };

function deps(all: FeedItem[], facts: Record<string, VideoFacts> = {}, watched: string[] = []): FeedDeps & { factCalls: string[][]; watchCalls: string[][] } {
  const d = {
    all, factCalls: [] as string[][], watchCalls: [] as string[][],
    facts: async (ids: string[]) => { d.factCalls.push(ids); return new Map(ids.filter((i) => facts[i]).map((i) => [i, facts[i]])); },
    watched: (ids: string[]) => { d.watchCalls.push(ids); return ids.filter((i) => watched.includes(i)); },
  };
  return d;
}

async function drain(d: FeedDeps, f: FeedFilter, limit: number) {
  const out: string[] = [];
  let cursor = null;
  for (let i = 0; i < 100; i++) {
    const p = await feedPage(d, f, limit, cursor);
    out.push(...p.items.map((x) => x.id));
    if (!p.next) return out;
    cursor = decodeCursor(p.next);
    assert.ok(cursor);
  }
  throw new Error("paging does not terminate");
}

test("cursor paging reaches every item exactly once, including timestamp ties", async () => {
  const same = "2026-02-01T00:00:00Z";
  const all = mergeFeeds([[...Array.from({ length: 12 }, (_, i) => item(i + 1, { publishedAt: same })), ...Array.from({ length: 8 }, (_, i) => item(i + 20))]], 400);
  for (const size of [1, 2, 3, 5, 7, 20, 100]) {
    const ids = await drain(deps(all), none, size);
    assert.deepEqual(ids, all.map((i) => i.id), `page size ${size}`);
  }
});

test("a cursor stays valid when the feed changes between pages", async () => {
  const all = mergeFeeds([Array.from({ length: 10 }, (_, i) => item(i + 1))], 400);
  const p1 = await feedPage(deps(all), none, 4, null);
  const newer = item(99, { publishedAt: "2030-01-01T00:00:00Z" });
  const p2 = await feedPage(deps([newer, ...all.slice(1)]), none, 4, decodeCursor(p1.next!));
  assert.deepEqual(p2.items.map((i) => i.id), all.slice(4, 8).map((i) => i.id));
});

test("cursors are validated", () => {
  const c = encodeCursor(item(5));
  assert.deepEqual(decodeCursor(c), { t: Date.parse(item(5).publishedAt), id: vid(5) });
  for (const bad of ["", "x", "!!!", Buffer.from("12:short").toString("base64url"), Buffer.from("abc:" + vid(1)).toString("base64url"), "A".repeat(100)]) assert.equal(decodeCursor(bad), null, bad);
});

test("mergeFeeds sorts newest first, breaks ties by id, drops duplicates and caps", () => {
  const a = item(1, { publishedAt: "2026-01-01T00:00:00Z" }), b = item(2, { publishedAt: "2026-01-01T00:00:00Z" }), c = item(3, { publishedAt: "2026-03-01T00:00:00Z" });
  assert.deepEqual(mergeFeeds([[a, b], [c, a]], 10).map((i) => i.id), [c.id, b.id, a.id]);
  assert.equal(mergeFeeds([Array.from({ length: 50 }, (_, i) => item(i + 1))], 10).length, 10);
});

test("channel filter", async () => {
  const all = mergeFeeds([[item(1), item(2, { channelId: ch("b") }), item(3), item(4, { channelId: ch("b") })]], 400);
  const ids = await drain(deps(all), { ...none, channel: ch("b") }, 1);
  assert.deepEqual(ids, [vid(2), vid(4)]);
  assert.deepEqual(await drain(deps(all), { ...none, channel: ch("c") }, 5), []);
});

test("hide watched: one query per chunk, and pages still fill up", async () => {
  const all = mergeFeeds([Array.from({ length: 30 }, (_, i) => item(i + 1))], 400);
  const watched = all.slice(0, 20).map((i) => i.id);
  const d = deps(all, {}, watched);
  const p = await feedPage(d, { ...none, hideWatched: true }, 5, null);
  assert.deepEqual(p.items.map((i) => i.id), all.slice(20, 25).map((i) => i.id));
  assert.equal(d.watchCalls.length, 1, "30 candidates fit in one chunk of 50");
  assert.deepEqual(await drain(deps(all, {}, watched), { ...none, hideWatched: true }, 4), all.slice(20).map((i) => i.id));
  assert.equal(d.factCalls.length, 0, "no duration lookups unless a Shorts/live filter is on");
});

test("shorts and live filters; unknown facts hide nothing", async () => {
  const all = mergeFeeds([Array.from({ length: 8 }, (_, i) => item(i + 1))], 400);
  const id = (n: number) => vid(n);
  const facts: Record<string, VideoFacts> = {
    [id(1)]: { duration: SHORT_MAX, live: false }, // a short
    [id(2)]: { duration: SHORT_MAX + 1, live: false }, // not
    [id(3)]: { duration: 0, live: true }, // live: duration 0 must not read as a short
    [id(4)]: { duration: 0, live: false, gone: true }, // deleted: shown
    [id(5)]: { duration: 30, live: false },
    // 6, 7: lookup returned nothing
  };
  const withShort = [...all.slice(0, 7), { ...all[7], short: true }];
  const hide = async (f: Partial<FeedFilter>) => (await drain(deps(withShort, facts), { ...none, ...f }, 3)).map((x) => Number(x.slice(1)));
  assert.deepEqual(await hide({}), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(await hide({ shorts: "hide" }), [2, 3, 4, 6, 7]);
  assert.deepEqual(await hide({ live: "hide" }), [1, 2, 4, 5, 6, 7, 8]);
  assert.deepEqual(await hide({ shorts: "hide", live: "hide" }), [2, 4, 6, 7]);
  const p = await feedPage(deps(withShort, facts), { ...none, live: "hide" }, 8, null);
  assert.equal(p.items.find((i) => i.id === id(2))?.durationSeconds, SHORT_MAX + 1);
});

test("combined filters and a failing lookup", async () => {
  const all = mergeFeeds([[item(1), item(2, { channelId: ch("b") }), item(3, { channelId: ch("b") }), item(4, { channelId: ch("b") }), item(5, { channelId: ch("b") })]], 400);
  const facts: Record<string, VideoFacts> = { [vid(2)]: { duration: 20, live: false }, [vid(3)]: { duration: 900, live: false }, [vid(4)]: { duration: 0, live: true }, [vid(5)]: { duration: 900, live: false } };
  const f: FeedFilter = { channel: ch("b"), hideWatched: true, shorts: "hide", live: "hide" };
  assert.deepEqual(await drain(deps(all, facts, [vid(5)]), f, 1), [vid(3)]);
  const broken: FeedDeps = { ...deps(all), facts: async () => { throw new Error("quota"); } };
  const quiet = console.error;
  console.error = () => {};
  try {
    assert.equal((await feedPage(broken, { ...none, shorts: "hide" }, 10, null)).items.length, 5);
  } finally {
    console.error = quiet;
  }
});

test("a cursor past the end gives an empty page", async () => {
  const all = mergeFeeds([[item(1)]], 400);
  assert.deepEqual(await feedPage(deps(all), none, 5, decodeCursor(encodeCursor(item(900, { publishedAt: "2000-01-01T00:00:00Z" })))), { items: [], next: undefined });
});

test("parseFilter: query wins over saved preferences, bad values are errors", () => {
  const q = (s: string) => new URLSearchParams(s);
  assert.deepEqual(parseFilter(q(""), DEFAULT_PREFS), { channel: undefined, hideWatched: false, shorts: "show", live: "show" });
  const saved = { hideWatched: true, shorts: "hide" as const, live: "hide" as const };
  assert.deepEqual(parseFilter(q(""), saved), { channel: undefined, hideWatched: true, shorts: "hide", live: "hide" });
  assert.deepEqual(parseFilter(q(`hideWatched=0&shorts=show&live=show&channel=${ch("a")}`), saved), { channel: ch("a"), hideWatched: false, shorts: "show", live: "show" });
  for (const bad of ["hideWatched=true", "shorts=1", "live=", "channel=UCx"]) assert.ok("error" in parseFilter(q(bad), DEFAULT_PREFS), bad);
});

test("RSS: /shorts/ links mark an entry as a Short", () => {
  const entry = (id: string, href: string) => `<entry><yt:videoId>${id}</yt:videoId><title>t</title><link rel="alternate" href="${href}"/><published>2026-01-01T00:00:00Z</published></entry>`;
  const items = parseFeed(`<feed><yt:channelId>${ch("a")}</yt:channelId>${entry("AAAAAAAAAAA", "https://www.youtube.com/shorts/AAAAAAAAAAA")}${entry("BBBBBBBBBBB", "https://www.youtube.com/watch?v=BBBBBBBBBBB")}</feed>`);
  assert.deepEqual(items.map((i) => i.short), [true, undefined]);
});

test("next is only offered when something behind it passes the filters", async () => {
  const all = mergeFeeds([Array.from({ length: 10 }, (_, i) => item(i + 1))], 400);
  const watched = all.slice(5).map((i) => i.id); // everything after the first five is hidden
  const f = { ...none, hideWatched: true };
  const p = await feedPage(deps(all, {}, watched), f, 5, null);
  assert.equal(p.items.length, 5);
  assert.equal(p.next, undefined, "the tail is all filtered: no Load more");
  const q = await feedPage(deps(all, {}, watched.slice(1)), f, 5, null);
  assert.ok(q.next, "one visible item remains behind the page");
  assert.deepEqual((await feedPage(deps(all, {}, watched.slice(1)), f, 5, decodeCursor(q.next!))).items.map((i) => i.id), [all[5].id]);
  assert.equal((await feedPage(deps(all), none, 10, null)).next, undefined, "an exactly full last page has no next");
  assert.ok((await feedPage(deps(all), none, 9, null)).next);
});
