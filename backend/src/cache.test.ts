import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { cacheSize, cached, clearCache } from "./cache.ts";

beforeEach(() => clearCache());

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
