import { test } from "node:test";
import assert from "node:assert/strict";
import { FAIL_TTL_MS, clearFailures, recentFailure, recordFailure } from "./dlp.ts";

test("a recorded failure is returned until its TTL ends, per key, and then forgotten", () => {
  clearFailures();
  const err = new Error("boom");
  recordFailure("AAAAAAAAAAA-720-en", err, 1_000);
  assert.equal(recentFailure("AAAAAAAAAAA-720-en", 1_000 + FAIL_TTL_MS - 1)?.err, err);
  assert.equal(recentFailure("AAAAAAAAAAA-480-en", 1_001), undefined, "another quality is a different key");
  assert.equal(recentFailure("AAAAAAAAAAA-720-pt", 1_001), undefined, "another language is a different key");
  assert.equal(recentFailure("BBBBBBBBBBB-720-en", 1_001), undefined);
  assert.equal(recentFailure("AAAAAAAAAAA-720-en", 1_000 + FAIL_TTL_MS), undefined, "expired");
  assert.equal(recentFailure("AAAAAAAAAAA-720-en", 1_001), undefined, "and gone for good");
});

test("the failure map stays bounded", () => {
  clearFailures();
  for (let i = 0; i < 1000; i++) recordFailure(`k${i}`, new Error("x"), 1);
  let n = 0;
  for (let i = 0; i < 1000; i++) if (recentFailure(`k${i}`, 2)) n++;
  assert.ok(n <= 200, `${n} kept`);
});
