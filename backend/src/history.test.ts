import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "./db.ts";
import { MAX_NEW_PER_HOUR, MAX_SECONDS, MAX_THUMB, resetNewRowLimit, clearHistory, continueWatching, getProgress, isKnown, listHistory, recordProgress, removeHistory, watchedAmong, type VideoMeta } from "./history.ts";
import { MAX_TITLE } from "./store.ts";

const vid = (n: number) => "v" + String(n).padStart(10, "0");
const meta = (id: string, duration = 600): VideoMeta => ({ id, title: "T " + id, channelId: "UC" + "a".repeat(22), channelTitle: "Chan", thumb: "https://i.ytimg.com/x.jpg", durationSeconds: duration });

let dir = "";
beforeEach(() => {
  resetNewRowLimit();
  dir = mkdtempSync(join(tmpdir(), "yt-hist-"));
  process.env.DATA_DIR = dir;
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("records a position, updates it in place, and exposes it for resume", () => {
  const id = vid(1);
  assert.equal(getProgress(id), null);
  assert.equal(recordProgress(id, 30, false, meta(id), 1000), "recorded");
  assert.deepEqual(getProgress(id), { position: 30, completed: false });
  assert.equal(recordProgress(id, 100.9, false, null, 2000), "recorded");
  const [row] = listHistory().items;
  assert.deepEqual(row, { id, title: "T " + id, channelId: "UC" + "a".repeat(22), channelTitle: "Chan", thumb: "https://i.ytimg.com/x.jpg", durationSeconds: 600, position: 100, completed: false, lastWatched: 2000, watchCount: 0 });
  assert.equal(listHistory().items.length, 1);
});

test("a short look (< 5 s) does not create a row; tiny moves (< 2 s) are ignored", () => {
  const id = vid(1);
  assert.equal(recordProgress(id, 4, false, meta(id)), "ignored");
  assert.equal(isKnown(id), false);
  assert.equal(recordProgress(id, 0, false, null), "ignored"); // unknown and no metadata
  recordProgress(id, 50, false, meta(id), 1000);
  assert.equal(recordProgress(id, 51, false, null, 2000), "ignored");
  assert.equal(listHistory().items[0].lastWatched, 1000, "an ignored update must not touch the row");
  assert.equal(recordProgress(id, 52, false, null, 3000), "recorded");
  assert.equal(recordProgress(id, 10, false, null, 4000), "recorded"); // seeking back is a real move
  assert.equal(getProgress(id)?.position, 10);
});

test("completion: within 10 s of the end, or finished by the client", () => {
  const a = vid(1), b = vid(2), c = vid(3);
  recordProgress(a, 589, false, meta(a), 1);
  assert.equal(getProgress(a)?.completed, false);
  recordProgress(a, 590, false, null, 2);
  assert.deepEqual(getProgress(a), { position: 590, completed: true });
  assert.equal(listHistory().items[0].watchCount, 1);
  recordProgress(b, 20, false, meta(b), 3);
  recordProgress(b, 21, true, null, 4); // finished wins even though the position barely moved
  assert.deepEqual(getProgress(b), { position: 600, completed: true });
  recordProgress(c, 9999, false, meta(c), 5); // beyond the end is clamped
  assert.deepEqual(getProgress(c), { position: 600, completed: true });
});

test("unknown duration: only the client can mark it finished", () => {
  const id = vid(1);
  recordProgress(id, 5000, false, meta(id, 0), 1);
  assert.equal(getProgress(id)?.completed, false);
  recordProgress(id, 6000, true, null, 2);
  assert.equal(getProgress(id)?.completed, true);
});

test("rewatching a completed video: a restart under 5 s is ignored, real progress reopens it, finishing counts again", () => {
  const id = vid(1);
  recordProgress(id, 600, true, meta(id), 1);
  assert.equal(recordProgress(id, 2, false, null, 2), "ignored");
  assert.equal(getProgress(id)?.completed, true);
  recordProgress(id, 60, false, null, 3);
  assert.deepEqual(getProgress(id), { position: 60, completed: false });
  recordProgress(id, 600, true, null, 4);
  assert.equal(listHistory().items[0].watchCount, 2);
});

test("continue watching: unfinished with position >= 5, newest first, at most 12", () => {
  for (let i = 1; i <= 15; i++) recordProgress(vid(i), 100, false, meta(vid(i)), i);
  recordProgress(vid(99), 600, true, meta(vid(99)), 100); // completed: excluded
  const rows = continueWatching();
  assert.equal(rows.length, 12);
  assert.equal(rows[0].id, vid(15));
  assert.ok(rows.every((r) => !r.completed && r.position >= 5));
  assert.equal(continueWatching(3).length, 3);
});

test("history pages newest first with an opaque cursor", () => {
  for (let i = 1; i <= 5; i++) recordProgress(vid(i), 100, false, meta(vid(i)), i * 10);
  const p1 = listHistory(2);
  assert.deepEqual(p1.items.map((r) => r.id), [vid(5), vid(4)]);
  assert.equal(typeof p1.next, "string");
  const p2 = listHistory(2, p1.next);
  assert.deepEqual(p2.items.map((r) => r.id), [vid(3), vid(2)]);
  const p3 = listHistory(2, p2.next);
  assert.deepEqual(p3.items.map((r) => r.id), [vid(1)]);
  assert.equal(p3.next, undefined);
  assert.equal(listHistory(1000).items.length, 5); // limit is capped, not an error
  assert.throws(() => listHistory(2, "garbage"), RangeError);
  assert.throws(() => listHistory(2, "1.2; DROP TABLE history"), RangeError);
});

test("rows with the same timestamp are neither skipped nor repeated across pages", () => {
  for (let i = 1; i <= 6; i++) recordProgress(vid(i), 100, false, meta(vid(i)), 5000); // same millisecond
  const seen: string[] = [];
  let cursor: string | undefined;
  do {
    const page = listHistory(2, cursor);
    seen.push(...page.items.map((r) => r.id));
    cursor = page.next;
  } while (cursor);
  assert.deepEqual([...seen].sort(), [1, 2, 3, 4, 5, 6].map(vid));
  assert.equal(new Set(seen).size, 6);
});

test("positions and durations are clamped to a sane maximum", () => {
  const id = vid(1), b = vid(2);
  recordProgress(id, 1e308, false, meta(id, 0), 1); // unknown duration, absurd position
  assert.equal(getProgress(id)?.position, MAX_SECONDS);
  recordProgress(b, 100, false, meta(b, 1e12), 2);
  assert.equal(listHistory().items[0].durationSeconds, MAX_SECONDS);
});

test("at most MAX_NEW_PER_HOUR new rows per hour; updates and later hours are unaffected", () => {
  for (let i = 0; i < MAX_NEW_PER_HOUR; i++) assert.equal(recordProgress(vid(i), 100, false, meta(vid(i)), 1000 + i), "recorded");
  assert.equal(recordProgress(vid(999), 100, false, meta(vid(999)), 2000), "limited");
  assert.equal(isKnown(vid(999)), false);
  assert.equal(recordProgress(vid(0), 200, false, null, 3000), "recorded"); // existing rows still update
  assert.equal(recordProgress(vid(999), 100, false, meta(vid(999)), 1000 + 3_600_001), "recorded");
});

test("prunes the oldest rows beyond the cap", () => {
  for (let i = 1; i <= 6; i++) recordProgress(vid(i), 100, false, meta(vid(i)), i, 4);
  assert.deepEqual(listHistory().items.map((r) => r.id), [vid(6), vid(5), vid(4), vid(3)]);
  assert.equal(isKnown(vid(1)), false);
});

test("stored text is capped and bad input throws", () => {
  const id = vid(1);
  const m = { ...meta(id), title: "x".repeat(5000), channelTitle: "y".repeat(5000), thumb: "z".repeat(5000) };
  recordProgress(id, 100, false, m, 1);
  const r = listHistory().items[0];
  assert.equal(r.title.length, MAX_TITLE);
  assert.equal(r.channelTitle.length, MAX_TITLE);
  assert.equal(r.thumb.length, MAX_THUMB);
  assert.throws(() => recordProgress("bad", 10, false, meta("bad")), RangeError);
  assert.throws(() => recordProgress(id, NaN, false, null), RangeError);
});

test("SQL is parameterised: hostile ids are inert", () => {
  assert.throws(() => recordProgress("x'; DROP TABLE history;--", 10, false, null), RangeError);
  assert.deepEqual(watchedAmong(["a' OR '1'='1", "x".repeat(11)]), []);
  assert.equal(removeHistory("' OR 1=1 --"), false);
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM history").get() as { n: number }).n, 0);
});

test("watchedAmong returns only completed ids; remove and clear", () => {
  recordProgress(vid(1), 600, true, meta(vid(1)), 1);
  recordProgress(vid(2), 100, false, meta(vid(2)), 2);
  assert.deepEqual(watchedAmong([vid(1), vid(2), vid(3), "bad"]), [vid(1)]);
  assert.equal(removeHistory(vid(1)), true);
  assert.equal(removeHistory(vid(1)), false);
  assert.equal(clearHistory(), 1);
  assert.deepEqual(listHistory().items, []);
});
