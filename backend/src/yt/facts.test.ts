import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTS_BACKOFF_MS, FACTS_BATCH, FACTS_TTL, MAX_FACT_CALLS_PER_HOUR, SHORT_FACTS_TTL, resetFactsLimits, videoFacts } from "./api.ts";
import { clearCache } from "../cache.ts";
import { closeDb } from "../db.ts";

let tmp = "";
const realFetch = globalThis.fetch;
let calls: string[][] = [];
const GONE = "G0000000000";

before(() => {
  tmp = mkdtempSync(join(tmpdir(), "yt-facts-"));
  process.env.DATA_DIR = tmp;
  process.env.YT_API_KEY = "test-key";
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    assert.ok(u.pathname.endsWith("/youtube/v3/videos"), u.pathname);
    const ids = (u.searchParams.get("id") ?? "").split(",");
    assert.ok(ids.length <= 50, "videos.list takes at most 50 ids");
    calls.push(ids);
    const items = ids.filter((i) => i !== GONE).map((id) => ({
      id, contentDetails: { duration: id.startsWith("S") ? "PT45S" : id.startsWith("L") ? "P0D" : "PT1H2M3S" },
      snippet: { liveBroadcastContent: id.startsWith("L") ? "live" : "none" },
    }));
    return new Response(JSON.stringify({ items }), { status: 200 });
  }) as typeof fetch;
});
after(() => {
  globalThis.fetch = realFetch;
  closeDb();
  rmSync(tmp, { recursive: true, force: true });
});

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(10, "0")}`);

test("durations: one Data API call per 50 unknown videos, none for known ones, persisted across a restart", async () => {
  calls = [];
  const all = [...ids("S", 60), ...ids("V", 90), ...ids("L", 2), GONE]; // 153 videos
  const m = await videoFacts(all);
  assert.equal(m.size, all.length);
  assert.equal(calls.length, Math.ceil(all.length / FACTS_BATCH), "4 calls for 153 videos");
  assert.deepEqual(m.get("S0000000000"), { duration: 45, live: false });
  assert.deepEqual(m.get("V0000000000"), { duration: 3723, live: false });
  assert.deepEqual(m.get("L0000000000"), { duration: 0, live: true });
  assert.equal(m.get(GONE)?.gone, true);

  calls = [];
  await videoFacts(all);
  assert.equal(calls.length, 0, "answered from the cache");
  clearCache(); // a restart: memory is gone, SQLite stays
  await videoFacts(all);
  assert.equal(calls.length, 0, "answered from SQLite");
  const more = await videoFacts([...ids("V", 3), "V9999999999"]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ["V9999999999"], "only the unknown id is requested");
  assert.equal(more.size, 4);
});

test("durations: concurrent callers share one lookup", async () => {
  calls = [];
  const fresh = ids("W", 10);
  await Promise.all([videoFacts(fresh), videoFacts(fresh.slice(0, 5))]);
  assert.equal(calls.length, 1);
});

test("durations: an API failure rejects and is not cached", async () => {
  const f = globalThis.fetch;
  globalThis.fetch = (async () => new Response("{}", { status: 403 })) as typeof fetch;
  await assert.rejects(videoFacts(ids("X", 3)));
  globalThis.fetch = f;
  calls = [];
  resetFactsLimits(); // the minute of back-off is tested below
  assert.equal((await videoFacts(ids("X", 3))).size, 3);
  assert.equal(calls.length, 1);
});

test("durations: after a failure no call is made for a minute, then lookups resume", async () => {
  resetFactsLimits();
  const f = globalThis.fetch;
  let failing = 0;
  globalThis.fetch = (async () => (failing++, new Response("{}", { status: 500 }))) as typeof fetch;
  await assert.rejects(videoFacts(ids("Y", 3)));
  await assert.rejects(videoFacts(ids("Z", 3)), /paused/);
  await assert.rejects(videoFacts(ids("Y", 3)), /paused/);
  assert.equal(failing, 1, "the outage cost one call, not one per request");
  globalThis.fetch = f;
  calls = [];
  const realNow = Date.now;
  Date.now = () => realNow() + FACTS_BACKOFF_MS + 1;
  try {
    assert.equal((await videoFacts(ids("Y", 3))).size, 3);
    assert.equal(calls.length, 1);
  } finally {
    Date.now = realNow;
  }
});

test("durations: deleted and duration-less entries are looked up again after the short TTL, real durations after a week", async () => {
  resetFactsLimits();
  const real = ["R0000000001"], odd = [GONE];
  await videoFacts([...real, ...odd]);
  calls = [];
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + SHORT_FACTS_TTL - 60_000;
    await videoFacts([...real, ...odd]);
    assert.equal(calls.length, 0, "still cached");
    Date.now = () => realNow() + SHORT_FACTS_TTL + 60_000;
    await videoFacts([...real, ...odd]);
    assert.deepEqual(calls.map((c) => c.sort()), [[...odd].sort()], "only the unknown-ish ones are asked again");
    calls = [];
    Date.now = () => realNow() + FACTS_TTL + 60_000;
    await videoFacts(real);
    assert.equal(calls.length, 1);
  } finally {
    Date.now = realNow;
  }
});

test("durations: at most MAX_FACT_CALLS_PER_HOUR Data API calls an hour", async () => {
  resetFactsLimits();
  calls = [];
  for (let i = 0; i < MAX_FACT_CALLS_PER_HOUR; i++) await videoFacts([`Q${String(i).padStart(10, "0")}`]);
  assert.equal(calls.length, MAX_FACT_CALLS_PER_HOUR);
  await assert.rejects(videoFacts(["Q9999999999"]), /limit/);
  assert.equal(calls.length, MAX_FACT_CALLS_PER_HOUR);
  assert.equal((await videoFacts(["Q0000000000"])).size, 1, "known videos never need a call");
});
