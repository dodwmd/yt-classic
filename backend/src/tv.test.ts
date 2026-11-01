import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_FEEDS, MAX_LOOKUPS, MAX_SEEN, TIME_BUDGET_MS, TV_MIN_SUBS, TvLimiter, parseSeen, pickNext, playable, shuffled, type TvDeps } from "./tv.ts";
import type { VideoDetail } from "./yt/api.ts";
import type { FeedItem } from "./yt/rss.ts";

const chan = (n: number) => "UC" + String(n).padStart(22, "0");
const vid = (c: number, i: number) => `v${String(c).padStart(4, "0")}${String(i).padStart(5, "0")}`.slice(0, 11);
const detail = (c: number, i: number, over: Partial<VideoDetail> = {}): VideoDetail => ({
  id: vid(c, i), title: `t${c}-${i}`, channelId: chan(c), channelTitle: `c${c}`, description: "", publishedAt: "2026-01-01T00:00:00Z", thumb: "", durationSeconds: 600, ...over,
});

/** A deterministic xorshift generator, so a failing run can be repeated. */
function prng(seed: number): () => number {
  let x = seed || 1;
  return () => {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    return x / 4294967296;
  };
}

interface World {
  channels: number;
  perChannel?: (c: number) => VideoDetail[];
  failing?: Set<number>;
  watched?: Set<string>;
}
function deps(w: World, over: Partial<TvDeps> = {}): TvDeps {
  const per = w.perChannel ?? ((c) => [detail(c, 1), detail(c, 2), detail(c, 3)]);
  const all = new Map<string, VideoDetail>();
  const byChan = new Map<string, VideoDetail[]>();
  for (let c = 1; c <= w.channels; c++) {
    const vs = per(c);
    byChan.set(chan(c), vs);
    for (const v of vs) all.set(v.id, v);
  }
  return {
    subs: [...byChan.keys()].map((id) => ({ id })),
    after: "",
    seen: new Set(),
    watched: (ids) => ids.filter((i) => w.watched?.has(i)),
    feed: async (id) => {
      if (w.failing?.has(Number(id.slice(2)))) throw new Error("feed down");
      return (byChan.get(id) ?? []).map((v): FeedItem => ({ id: v.id, title: v.title, channelId: v.channelId, channelTitle: v.channelTitle, publishedAt: v.publishedAt }));
    },
    video: async (id) => all.get(id) ?? null,
    rand: prng(7),
    ...over,
  };
}

test("the minimum is five subscriptions", () => assert.equal(TV_MIN_SUBS, 5));

test("never the same channel twice in a row (hundreds of draws over exactly five channels)", async () => {
  const d = deps({ channels: 5 }, { rand: prng(42) });
  let after = "";
  const counts = new Map<string, number>();
  for (let n = 0; n < 500; n++) {
    const v = await pickNext({ ...d, after });
    assert.ok(v, `draw ${n} found nothing`);
    assert.notEqual(v.channelId, after, `draw ${n} repeated the channel`);
    counts.set(v.channelId, (counts.get(v.channelId) ?? 0) + 1);
    after = v.channelId;
  }
  assert.equal(counts.size, 5, "every channel gets picked");
  for (const n of counts.values()) assert.ok(n > 50, `a channel is starved: ${n}`);
});

test("still never repeats when some channels have nothing playable or fail, and after is set", async () => {
  const d = deps({
    channels: 5,
    perChannel: (c) => (c === 2 ? [] : c === 3 ? [detail(c, 1, { durationSeconds: 30 })] : [detail(c, 1), detail(c, 2)]),
    failing: new Set([4]),
  }, { rand: prng(99) });
  let after = chan(1);
  const seen = new Set<string>();
  for (let n = 0; n < 400; n++) {
    const v = await pickNext({ ...d, after });
    assert.ok(v, `draw ${n} found nothing`);
    assert.notEqual(v.channelId, after);
    assert.ok([chan(1), chan(5)].includes(v.channelId), `picked unplayable channel ${v.channelId}`);
    seen.add(v.channelId);
    after = v.channelId;
  }
  assert.deepEqual([...seen].sort(), [chan(1), chan(5)]);
});

test("a set of only the `after` channel's videos yields null rather than a repeat", async () => {
  const d = deps({ channels: 5, perChannel: (c) => (c === 1 ? [detail(c, 1)] : []) });
  assert.equal(await pickNext({ ...d, after: chan(1) }), null);
  assert.equal((await pickNext({ ...d, after: chan(2) }))?.channelId, chan(1));
});

test("`seen` ids are never returned", async () => {
  const d = deps({ channels: 5, perChannel: (c) => [detail(c, 1), detail(c, 2)] });
  const seen = new Set<string>();
  for (let c = 1; c <= 5; c++) seen.add(vid(c, 1));
  for (let n = 0; n < 100; n++) {
    const v = await pickNext({ ...d, seen, rand: prng(n + 1) });
    assert.ok(v);
    assert.ok(!seen.has(v.id));
  }
  // Everything seen: nothing to play, even though watched videos are allowed in the fallback.
  for (let c = 1; c <= 5; c++) seen.add(vid(c, 2));
  assert.equal(await pickNext({ ...d, seen }), null);
});

test("watched videos are excluded, and used only when nothing unwatched is left", async () => {
  const world: World = { channels: 5, perChannel: (c) => [detail(c, 1), detail(c, 2)], watched: new Set() };
  for (let c = 1; c <= 5; c++) world.watched!.add(vid(c, 1));
  for (let n = 0; n < 100; n++) {
    const v = await pickNext(deps(world, { rand: prng(n + 3) }));
    assert.ok(v && v.id.endsWith("00002"), `picked watched ${v?.id}`);
  }
  for (let c = 1; c <= 5; c++) world.watched!.add(vid(c, 2));
  const v = await pickNext(deps(world));
  assert.ok(v, "fallback allows watched videos once everything is watched");
  assert.equal(await pickNext(deps(world, { seen: new Set([...world.watched!]) })), null, "but never ones in seen");
});

test("a channel with unwatched videos wins over watched-only channels", async () => {
  const watched = new Set([vid(1, 1), vid(2, 1), vid(3, 1), vid(4, 1)]);
  const world: World = { channels: 5, perChannel: (c) => [detail(c, 1)], watched };
  for (let n = 0; n < 50; n++) assert.equal((await pickNext(deps(world, { rand: prng(n + 1) })))?.channelId, chan(5));
});

test("Shorts, live, upcoming and videos without a duration are skipped", async () => {
  const bad = (c: number) => [
    detail(c, 1, { durationSeconds: 60 }), detail(c, 2, { liveBroadcastContent: "live" }),
    detail(c, 3, { liveBroadcastContent: "upcoming" }), detail(c, 4, { durationSeconds: undefined }),
  ];
  const world: World = { channels: 5, perChannel: (c) => (c === 5 ? [...bad(c), detail(c, 6, { durationSeconds: 61 })] : bad(c)) };
  for (let n = 0; n < 50; n++) {
    const v = await pickNext(deps(world, { rand: prng(n + 1) }));
    assert.equal(v?.id, vid(5, 6));
  }
  assert.ok(!playable(detail(1, 1, { durationSeconds: 60 })));
  assert.ok(playable(detail(1, 1, { durationSeconds: 61 })));
  assert.ok(!playable(null));
});

test("a failing metadata lookup is attempted and skipped, never returned", async () => {
  const d = deps({ channels: 5 });
  const asked: string[] = [];
  const v = await pickNext({ ...d, rand: () => 0, video: async (id) => { asked.push(id); if (asked.length === 1) throw new Error("boom"); return d.video(id); } });
  assert.ok(v, "moves on to another candidate");
  assert.ok(asked.length >= 2, "the failing one was really attempted first");
  assert.notEqual(v.id, asked[0]);
  // Everything failing ends in null, within the lookup budget.
  let lookups = 0;
  assert.equal(await pickNext({ ...d, video: async () => { lookups++; throw new Error("down"); } }), null);
  assert.ok(lookups > 0 && lookups <= MAX_LOOKUPS, `lookups ${lookups}`);
  assert.equal(await pickNext(deps({ channels: 5, failing: new Set([1, 2, 3, 4, 5]) })), null);
});

test("the `after` channel is never even examined (not rescued by a later check)", async () => {
  const d = deps({ channels: 5 });
  const asked = new Set<string>();
  for (let n = 0; n < 50; n++) {
    await pickNext({ ...d, after: chan(2), rand: prng(n + 1), feed: async (c) => { asked.add(c); return d.feed(c); } });
  }
  assert.ok(!asked.has(chan(2)), "feed of the after channel was fetched");
  assert.equal(asked.size, 4);
});

test("30 channels with 24 watched-only: unwatched videos always win, over 2000 draws", async () => {
  const watched = new Set<string>();
  const world: World = { channels: 30, perChannel: (c) => [detail(c, 1), detail(c, 2)], watched };
  for (let c = 7; c <= 30; c++) for (const i of [1, 2]) watched.add(vid(c, i));
  const d = deps(world);
  let after = "";
  let nulls = 0;
  for (let n = 0; n < 2000; n++) {
    const v = await pickNext({ ...d, after, rand: prng(n + 11) });
    if (!v) { nulls++; continue; }
    assert.ok(!watched.has(v.id), `draw ${n} picked watched ${v.id}`);
    assert.notEqual(v.channelId, after);
    after = n % 7 === 0 ? "" : v.channelId;
  }
  assert.ok(nulls < 20, `too many empty draws: ${nulls}`);
});

test("40 subscriptions with 37 dead feeds: the three live channels are always found", async () => {
  const failing = new Set<number>();
  for (let c = 4; c <= 40; c++) failing.add(c);
  const d = deps({ channels: 40, failing });
  for (let n = 0; n < 300; n++) {
    const v = await pickNext({ ...d, rand: prng(n + 5) });
    assert.ok(v, `draw ${n} found nothing`);
    assert.ok([chan(1), chan(2), chan(3)].includes(v.channelId));
  }
});

test("the work per request is bounded: feeds, lookups and time", async () => {
  let feeds = 0;
  const big = deps({ channels: 200, failing: new Set(Array.from({ length: 200 }, (_, i) => i + 1)) });
  assert.equal(await pickNext({ ...big, feed: async () => { feeds++; throw new Error("down"); } }), null);
  assert.ok(feeds <= MAX_FEEDS, `feeds ${feeds}`);
  let lookups = 0;
  const unplayable = deps({ channels: 200 });
  assert.equal(await pickNext({ ...unplayable, video: async () => { lookups++; return null; } }), null);
  assert.ok(lookups <= MAX_LOOKUPS, `lookups ${lookups}`);
  // Time: a clock that jumps past the budget after the first batch stops the walk.
  let t = 0;
  let asked = 0;
  assert.equal(await pickNext({ ...unplayable, now: () => t, feed: async (c) => { asked++; t += TIME_BUDGET_MS; return unplayable.feed(c); }, video: async () => null }), null);
  assert.ok(asked <= 4, `kept going after the time budget: ${asked}`);
});

test("a client that went away stops the pick", async () => {
  const d = deps({ channels: 20 });
  const ac = new AbortController();
  let feeds = 0;
  const v = await pickNext({ ...d, signal: ac.signal, feed: async (c) => { feeds++; ac.abort(); return d.feed(c); }, video: async () => null });
  assert.equal(v, null);
  assert.ok(feeds <= 4, `kept fetching feeds after the abort: ${feeds}`);
});

test("TvLimiter: a small burst, then one a second, and an hourly cap", () => {
  const l = new TvLimiter(3, 1, 10);
  const t0 = 1_000_000;
  assert.equal(l.take(t0), 0);
  assert.equal(l.take(t0), 0);
  assert.equal(l.take(t0), 0);
  assert.ok(l.take(t0) >= 1, "fourth in the same instant is refused");
  assert.equal(l.take(t0 + 1500), 0, "a second later one more is allowed");
  assert.ok(l.take(t0 + 1500) >= 1);
  const h = new TvLimiter(100, 100, 5);
  for (let i = 0; i < 5; i++) assert.equal(h.take(t0 + i), 0);
  const wait = h.take(t0 + 10);
  assert.ok(wait > 3000, `hourly cap should ask for a long wait, got ${wait}`);
  assert.equal(h.take(t0 + 3_600_001 + 4), 0, "the window slides");
});

test("randomness is injectable: same source, same pick; different source reaches different picks", async () => {
  const d = deps({ channels: 5 });
  const a = await pickNext({ ...d, rand: () => 0 });
  const b = await pickNext({ ...d, rand: () => 0 });
  assert.equal(a?.id, b?.id);
  const hi = await pickNext({ ...d, rand: () => 0.999 });
  assert.notEqual(hi?.id, a?.id);
});

test("shuffled is a permutation and does not touch its input", () => {
  const src = [1, 2, 3, 4, 5, 6];
  const out = shuffled(src, prng(5));
  assert.deepEqual([...out].sort((x, y) => x - y), src);
  assert.deepEqual(src, [1, 2, 3, 4, 5, 6]);
});

test("parseSeen drops malformed ids and bounds both length and count", () => {
  assert.deepEqual([...parseSeen("AAAAAAAAAAA,bad,BBBBBBBBBBB,,<script>1")], ["AAAAAAAAAAA", "BBBBBBBBBBB"]);
  const many = Array.from({ length: 500 }, (_, i) => String(i).padStart(11, "x")).join(",");
  assert.ok(parseSeen(many).size <= MAX_SEEN);
});
