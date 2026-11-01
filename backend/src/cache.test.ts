import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CACHE_VERSION, cacheSize, cached, clearCache, pruneDisk } from "./cache.ts";
import { closeDb, getDb } from "./db.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-cache-"));
  process.env.DATA_DIR = dir;
  clearCache();
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});
const rows = () => (getDb().prepare("SELECT COUNT(*) AS n FROM cache").get() as { n: number }).n;
const withClock = async (offsetMs: number, fn: () => Promise<void>) => {
  const real = Date.now;
  Date.now = () => real() + offsetMs;
  try {
    await fn();
  } finally {
    Date.now = real;
  }
};

test("concurrent misses share one call", async () => {
  let calls = 0;
  const fn = async () => (calls++, await new Promise((r) => setTimeout(r, 20)), "v");
  const [a, b] = await Promise.all([cached("k", 1000, fn), cached("k", 1000, fn)]);
  assert.deepEqual([a, b, calls], ["v", "v", 1]);
});

test("failures are not cached", async () => {
  let calls = 0;
  const flaky = async () => {
    if (calls++ === 0) throw new Error("boom");
    return "ok";
  };
  await assert.rejects(cached("f", 1000, flaky));
  assert.equal(await cached("f", 1000, flaky), "ok");
});

test("empty results only get a short TTL", async () => {
  let calls = 0;
  await cached("e", 3_600_000, async () => (calls++, [] as string[]));
  await cached("e", 3_600_000, async () => (calls++, [] as string[]));
  assert.equal(calls, 1); // still cached briefly...
  const real = Date.now;
  Date.now = () => real() + 61_000;
  try {
    await cached("e", 3_600_000, async () => (calls++, [] as string[]));
  } finally {
    Date.now = real;
  }
  assert.equal(calls, 2); // ...but not for the full hour
});

test("size is bounded", async () => {
  for (let i = 0; i < 700; i++) await cached(`k${i}`, 60_000, async () => i);
  assert.ok(cacheSize() <= 500);
});

test("persistent entries survive a restart", async () => {
  let calls = 0;
  const fn = async () => (calls++, { items: [1, 2], nested: { a: "b" } });
  const first = await cached("p", 60_000, fn, true);
  clearCache(); // memory gone, as after a restart
  closeDb(); // and the connection too
  assert.deepEqual(await cached("p", 60_000, fn, true), first);
  assert.equal(calls, 1);
});

test("non-persistent entries are memory only", async () => {
  let calls = 0;
  await cached("m", 60_000, async () => (calls++, "v"));
  assert.equal(rows(), 0);
  clearCache();
  await cached("m", 60_000, async () => (calls++, "v"));
  assert.equal(calls, 2);
});

test("persisted entries respect their TTL", async () => {
  let calls = 0;
  const fn = async () => (calls++, "v");
  await cached("t", 1000, fn, true);
  clearCache();
  await withClock(1500, async () => void (await cached("t", 1000, fn, true)));
  assert.equal(calls, 2);
});

test("empty results are not persisted", async () => {
  await cached("e", 60_000, async () => [] as number[], true);
  assert.equal(rows(), 0);
});

test("failures are not persisted", async () => {
  await assert.rejects(cached("f", 60_000, async () => Promise.reject(new Error("boom")), true));
  assert.equal(rows(), 0);
});

const seed = (key: string, used: number, size = 10, exp = Date.now() + 3_600_000) =>
  getDb().prepare("INSERT OR REPLACE INTO cache (key, val, exp, used, size) VALUES (?, ?, ?, ?, ?)").run(key, JSON.stringify("x".repeat(size - 2)), exp, used, size);
const keys = () => (getDb().prepare("SELECT key FROM cache ORDER BY key").all() as { key: string }[]).map((r) => r.key);

test("pruning removes expired rows and keeps the most recently used ones", () => {
  seed("old-expired", 100, 10, Date.now() - 1);
  seed("v1", 10);
  seed("v2", 40);
  seed("v3", 20);
  seed("v4", 30);
  assert.equal(pruneDisk(2), 3); // the expired row and the two least recently used
  assert.deepEqual(keys(), ["v2", "v4"]);
});

test("feed rows (rss:) outrank browsing rows, whatever their age", () => {
  seed("rss:UC1", 1);
  seed("rss:UC2", 2);
  for (let i = 0; i < 5; i++) seed(`video:${i}`, 1000 + i);
  pruneDisk(3);
  assert.deepEqual(keys(), ["rss:UC1", "rss:UC2", "video:4"]);
});

test("pruning enforces the total byte budget, counting bytes not characters", () => {
  seed("a", 4, 100);
  seed("b", 3, 100);
  seed("c", 2, 100);
  assert.equal(pruneDisk(100, 250), 1);
  assert.deepEqual(keys(), ["a", "b"]);
});

test("the byte budget counts bytes, not characters", () => {
  seed("narrow", 4, 100);
  getDb().prepare("INSERT INTO cache (key, val, exp, used, size) VALUES ('wide', ?, ?, 9, 200)").run("\u00e9".repeat(100), Date.now() + 1e6); // 100 chars, 200 bytes
  pruneDisk(100, 250);
  assert.deepEqual(keys(), ["wide"]); // 300 bytes in total; 200 characters would have fit
});

test("a value over the byte limit (multi-byte characters) is not persisted", async () => {
  await cached("big", 60_000, async () => "\u00e9".repeat(600_000), true); // 600k chars, 1.2 MB
  assert.equal(rows(), 0);
  await cached("fits", 60_000, async () => "\u00e9".repeat(400_000), true); // 800 kB
  assert.equal(rows(), 1);
});

test("opening the database prunes what piled up", async () => {
  await cached("seed", 60_000, async () => 1, true);
  for (let i = 0; i < 20; i++) seed(`stale${i}`, 1, 10, Date.now() - 1);
  assert.equal(rows(), 21);
  closeDb();
  getDb();
  assert.equal(rows(), 1);
});

test("rows written under another CACHE_VERSION are never served", async () => {
  await cached("shape", 60_000, async () => ({ old: true }), true);
  getDb().prepare("UPDATE meta SET value = '0' WHERE key = 'cache_version'").run(); // as if written by an older deploy
  closeDb();
  clearCache();
  assert.deepEqual(await cached("shape", 60_000, async () => ({ new: true }), true), { new: true });
  assert.equal(getDb().prepare("SELECT value FROM meta WHERE key = 'cache_version'").get()!.value, String(CACHE_VERSION));
});

test("memory hits refresh the disk recency at most once a minute", async () => {
  await cached("hot", 3_600_000, async () => 1, true);
  const used = () => (getDb().prepare("SELECT used FROM cache WHERE key = 'hot'").get() as { used: number }).used;
  getDb().prepare("UPDATE cache SET used = 1 WHERE key = 'hot'").run();
  await cached("hot", 3_600_000, async () => 1, true); // within the minute of the write: untouched
  assert.equal(used(), 1);
  await withClock(61_000, async () => void (await cached("hot", 3_600_000, async () => 1, true)));
  assert.ok(used() > 1);
  getDb().prepare("UPDATE cache SET used = 1 WHERE key = 'hot'").run();
  await withClock(62_000, async () => void (await cached("hot", 3_600_000, async () => 1, true)));
  assert.equal(used(), 1, "throttled");
});

test("a broken database never breaks a request", async () => {
  await cached("x", 60_000, async () => 1, true);
  getDb().exec("DROP TABLE cache");
  const real = console.error;
  console.error = () => {};
  try {
    assert.equal(await cached("y", 60_000, async () => 2, true), 2); // write fails, value still returned
    clearCache();
    assert.equal(await cached("y", 60_000, async () => 3, true), 3); // read fails, falls back to the fetch
  } finally {
    console.error = real;
  }
});

test("the persisted size column is the byte length of the value", async () => {
  await cached("sz", 60_000, async () => "\u00e9".repeat(50), true);
  const row = getDb().prepare("SELECT size, length(CAST(val AS BLOB)) AS bytes FROM cache WHERE key = 'sz'").get() as { size: number; bytes: number };
  assert.equal(row.size, 102);
  assert.equal(row.size, row.bytes);
});
