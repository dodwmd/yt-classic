import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheSize, cached, clearCache, pruneDisk } from "./cache.ts";
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

test("pruning removes expired rows and caps the table", async () => {
  for (let i = 0; i < 10; i++) await cached(`s${i}`, 1000, async () => i, true);
  for (let i = 0; i < 10; i++) await cached(`l${i}`, 3_600_000, async () => i, true);
  assert.equal(rows(), 20);
  await withClock(5000, async () => assert.equal(pruneDisk(100), 10)); // the short-lived ones
  assert.equal(rows(), 10);
  assert.equal(pruneDisk(4), 6);
  assert.equal(rows(), 4);
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
