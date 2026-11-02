import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./db.ts";
import { MAX_RECENT_QUERY, MAX_SEARCHES, clearSearches, listSearches, recordSearch, removeSearch } from "./searches.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-searches-"));
  process.env.DATA_DIR = dir;
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const queries = () => listSearches().map((s) => s.query);

test("newest first; a repeat (any case or spacing) moves to the top and keeps the latest spelling", () => {
  recordSearch("cats", 1);
  recordSearch("dogs", 2);
  recordSearch("  CATS ", 3);
  assert.deepEqual(queries(), ["CATS", "dogs"]);
  recordSearch("big   dogs", 4);
  recordSearch("big dogs", 5);
  assert.deepEqual(queries(), ["big dogs", "CATS", "dogs"]);
  assert.equal(listSearches().length, 3);
});

test("empty and whitespace-only queries are ignored; long ones are cut", () => {
  recordSearch("", 1);
  recordSearch("   ", 2);
  assert.deepEqual(queries(), []);
  recordSearch("x".repeat(MAX_RECENT_QUERY + 50), 3);
  assert.equal(listSearches()[0].query.length, MAX_RECENT_QUERY);
});

test("capped at 50: the oldest go first, and a repeat saves a row from eviction", () => {
  for (let i = 0; i < MAX_SEARCHES; i++) recordSearch(`q${i}`, 1000 + i);
  assert.equal(listSearches().length, MAX_SEARCHES);
  recordSearch("q0", 5000); // oldest, searched again
  recordSearch("fresh", 5001); // pushes out the now-oldest (q1)
  const q = queries();
  assert.equal(q.length, MAX_SEARCHES);
  assert.equal(q[0], "fresh");
  assert.equal(q[1], "q0");
  assert.ok(!q.includes("q1"));
  assert.ok(q.includes("q2"));
  recordSearch("tiny cap", 6000, 3);
  assert.equal(listSearches().length, 3);
});

test("same-millisecond searches keep their order; remove and clear report what they removed", () => {
  recordSearch("a", 7);
  recordSearch("b", 7);
  recordSearch("c", 7);
  assert.deepEqual(queries(), ["c", "b", "a"]);
  const [{ id }] = listSearches();
  assert.equal(removeSearch(id), true);
  assert.equal(removeSearch(id), false);
  assert.equal(clearSearches(), 2);
  assert.equal(clearSearches(), 0);
  assert.deepEqual(queries(), []);
});

test("the text is stored as data (quotes and SQL-looking input are harmless)", () => {
  recordSearch(`'); DROP TABLE searches; --`, 1);
  assert.deepEqual(queries(), [`'); DROP TABLE searches; --`]);
});
