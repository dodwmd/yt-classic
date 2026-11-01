import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTS_BATCH, videoFacts } from "./api.ts";
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
  assert.equal((await videoFacts(ids("X", 3))).size, 3);
  assert.equal(calls.length, 1);
});
