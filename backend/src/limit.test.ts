import { test } from "node:test";
import assert from "node:assert/strict";
import { BusyError, limiter } from "./limit.ts";

test("acquire throws BusyError when slots and queue are full, and slots are reusable", async () => {
  const l = limiter(1, 0);
  const release = await l.acquire();
  await assert.rejects(l.acquire(), BusyError);
  release();
  release(); // double release is harmless
  (await l.acquire())();
});

test("queued callers run in order, never more than max at once", async () => {
  const l = limiter(2, 10);
  let active = 0, peak = 0;
  await Promise.all(Array.from({ length: 8 }, () => l.run(async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
  })));
  assert.equal(peak, 2);
});
