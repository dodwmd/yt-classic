import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "./db.ts";
import type { VideoMeta } from "./history.ts";
import { MAX_ITEMS, MAX_NAME, MAX_PLAYLISTS, WATCH_LATER, addItem, canAdd, cleanName, createPlaylist, deletePlaylist, getPlaylist, listItems, listPlaylists, membership, moveItem, refreshMeta, removeItem, renamePlaylist } from "./playlists.ts";

const vid = (n: number) => "v" + String(n).padStart(10, "0");
const meta = (id: string): VideoMeta => ({ id, title: "T " + id, channelId: "UC" + "a".repeat(22), channelTitle: "Chan", thumb: "https://i.ytimg.com/x.jpg", durationSeconds: 600 });
const ids = (pid: number) => listItems(pid, 100).items.map((i) => i.id);

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-pl-"));
  process.env.DATA_DIR = dir;
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("Watch later exists from the start, first in the list, and cannot be renamed or deleted", () => {
  assert.deepEqual(listPlaylists(), [{ id: WATCH_LATER, name: "Watch later", count: 0, builtin: true }]);
  assert.equal(renamePlaylist(WATCH_LATER, "Other"), "builtin");
  assert.equal(deletePlaylist(WATCH_LATER), "builtin");
  assert.equal(createPlaylist("WATCH LATER"), "exists");
  assert.equal(getPlaylist(WATCH_LATER)?.name, "Watch later");
});

test("names: trimmed, 1..80 code points, no control characters, unique ignoring case", () => {
  assert.equal(cleanName("   "), null);
  assert.equal(cleanName("a\nb"), null);
  assert.equal(cleanName("a\u0000b"), null);
  assert.equal(cleanName("x".repeat(MAX_NAME + 1)), null);
  assert.equal(cleanName("x".repeat(MAX_NAME)), "x".repeat(MAX_NAME));
  assert.equal(cleanName("😀".repeat(MAX_NAME)), "😀".repeat(MAX_NAME));
  assert.equal(cleanName("  Café "), "Café");
  const a = createPlaylist(" Music ");
  assert.ok(typeof a !== "string" && a.name === "Music" && !a.builtin);
  assert.equal(createPlaylist("music"), "exists");
  assert.equal(createPlaylist(""), "invalid");
  const b = createPlaylist("Talks");
  assert.ok(typeof b !== "string");
  assert.equal(renamePlaylist((b as { id: number }).id, "MUSIC"), "exists");
  const r = renamePlaylist((b as { id: number }).id, "talks"); // same playlist, only the case changes
  assert.ok(typeof r !== "string" && r.name === "talks");
  assert.equal(renamePlaylist(999, "Nope"), "missing");
  assert.deepEqual(listPlaylists().map((p) => p.name), ["Watch later", "Music", "talks"]);
});

test("at most 50 playlists", () => {
  for (let i = 1; i < MAX_PLAYLISTS; i++) assert.equal(typeof createPlaylist("p" + i), "object");
  assert.equal(listPlaylists().length, MAX_PLAYLISTS);
  assert.equal(createPlaylist("one too many"), "full");
  const first = listPlaylists()[1];
  assert.equal(deletePlaylist(first.id), "removed");
  assert.equal(typeof createPlaylist("fits again"), "object");
});

test("items: appended in order, deduplicated, idempotent", () => {
  assert.equal(addItem(WATCH_LATER, meta(vid(1)), 10), "added");
  assert.equal(addItem(WATCH_LATER, meta(vid(2)), 10), "added"); // same timestamp: order is still insertion order
  assert.equal(addItem(WATCH_LATER, meta(vid(1)), 20), "present");
  assert.deepEqual(ids(WATCH_LATER), [vid(1), vid(2)]);
  assert.equal(getPlaylist(WATCH_LATER)?.count, 2);
  assert.equal(listItems(WATCH_LATER).items[0].added, 10, "a repeated add must not touch the row");
  assert.equal(addItem(WATCH_LATER, meta("bad id"), 1), "invalid");
  assert.equal(addItem(999, meta(vid(3))), "missing");
  assert.equal(canAdd(WATCH_LATER, vid(1)), "present");
  assert.equal(canAdd(WATCH_LATER, vid(3)), "ok");
  assert.equal(canAdd(999, vid(3)), "missing");
  // the same video can live in several playlists
  const p = createPlaylist("Other") as { id: number };
  assert.equal(addItem(p.id, meta(vid(1))), "added");
});

test("at most 500 items per playlist; a different playlist still has room", () => {
  for (let i = 0; i < MAX_ITEMS; i++) assert.equal(addItem(WATCH_LATER, meta(vid(i))), "added");
  assert.equal(addItem(WATCH_LATER, meta(vid(MAX_ITEMS))), "full");
  assert.equal(canAdd(WATCH_LATER, vid(MAX_ITEMS)), "full");
  assert.equal(addItem(WATCH_LATER, meta(vid(0))), "present", "an existing item stays idempotent when full");
  const p = createPlaylist("Other") as { id: number };
  assert.equal(addItem(p.id, meta(vid(MAX_ITEMS))), "added");
  assert.equal(removeItem(WATCH_LATER, vid(0)), true);
  assert.equal(addItem(WATCH_LATER, meta(vid(MAX_ITEMS))), "added");
});

test("stored text is capped", () => {
  const m = { ...meta(vid(1)), title: "t".repeat(1000), channelTitle: "c".repeat(1000), thumb: "h".repeat(1000), durationSeconds: 1e12 };
  addItem(WATCH_LATER, m);
  const [i] = listItems(WATCH_LATER).items;
  assert.equal(i.title.length, 200);
  assert.equal(i.channelTitle.length, 200);
  assert.equal(i.thumb.length, 300);
  assert.equal(i.durationSeconds, 100 * 3600);
});

test("move: to the top, to the middle, past the end; unknown item", () => {
  for (let i = 1; i <= 5; i++) addItem(WATCH_LATER, meta(vid(i)));
  assert.equal(moveItem(WATCH_LATER, vid(5), 0), true);
  assert.deepEqual(ids(WATCH_LATER), [vid(5), vid(1), vid(2), vid(3), vid(4)]);
  moveItem(WATCH_LATER, vid(5), 2);
  assert.deepEqual(ids(WATCH_LATER), [vid(1), vid(2), vid(5), vid(3), vid(4)]);
  moveItem(WATCH_LATER, vid(1), 99);
  assert.deepEqual(ids(WATCH_LATER), [vid(2), vid(5), vid(3), vid(4), vid(1)]);
  assert.equal(moveItem(WATCH_LATER, vid(9), 0), false);
  addItem(WATCH_LATER, meta(vid(6)));
  assert.equal(ids(WATCH_LATER).at(-1), vid(6), "new items still go to the end after a move");
  const p = createPlaylist("Other") as { id: number };
  assert.equal(moveItem(p.id, vid(2), 0), false, "an item of another playlist is not found");
});

test("removing an item", () => {
  addItem(WATCH_LATER, meta(vid(1)));
  assert.equal(removeItem(WATCH_LATER, vid(1)), true);
  assert.equal(removeItem(WATCH_LATER, vid(1)), false);
  assert.deepEqual(ids(WATCH_LATER), []);
});

test("cursor paging walks every item once, including rows that share a position", () => {
  for (let i = 0; i < 7; i++) addItem(WATCH_LATER, meta(vid(i)));
  getDb().exec("UPDATE playlist_items SET position = 3 WHERE position IN (3, 4, 5)"); // a three-way tie
  const seen: string[] = [];
  let before = "";
  let pages = 0;
  for (;;) {
    const page = listItems(WATCH_LATER, 2, before);
    seen.push(...page.items.map((i) => i.id));
    pages++;
    if (!page.next) break;
    before = page.next;
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6].map(vid));
  assert.equal(pages, 4);
  assert.throws(() => listItems(WATCH_LATER, 2, "abc"), RangeError);
  assert.throws(() => listItems(WATCH_LATER, 2, "1"), RangeError);
});

test("cursor paging copes with negative positions", () => {
  for (let i = 0; i < 3; i++) addItem(WATCH_LATER, meta(vid(i)));
  getDb().exec("UPDATE playlist_items SET position = position - 10");
  const a = listItems(WATCH_LATER, 2);
  assert.match(a.next!, /^-\d+\.\d+$/);
  assert.deepEqual(listItems(WATCH_LATER, 2, a.next).items.map((i) => i.id), [vid(2)]);
});

test("deleting a playlist deletes its items, and only its items", () => {
  const p = createPlaylist("Other") as { id: number };
  addItem(p.id, meta(vid(1)));
  addItem(WATCH_LATER, meta(vid(1)));
  assert.equal(deletePlaylist(p.id), "removed");
  assert.equal(deletePlaylist(p.id), "missing");
  assert.equal((getDb().prepare("SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?").get(p.id) as { n: number }).n, 0);
  assert.deepEqual(ids(WATCH_LATER), [vid(1)]);
});

test("membership: Watch later vs any playlist; bounded and validated", () => {
  const p = createPlaylist("Other") as { id: number };
  addItem(WATCH_LATER, meta(vid(1)));
  addItem(p.id, meta(vid(2)));
  addItem(p.id, meta(vid(1)));
  const m = membership([vid(1), vid(2), vid(3), "bad", vid(1)]);
  assert.deepEqual(m.watchLater, [vid(1)]);
  assert.deepEqual(m.any.sort(), [vid(1), vid(2)]);
  assert.deepEqual(membership([]), { watchLater: [], any: [] });
  const many = Array.from({ length: 300 }, (_, i) => vid(i));
  for (let i = 0; i < 300; i++) addItem(p.id, meta(vid(i)));
  assert.equal(membership(many).any.length, 100, "at most 100 ids are looked at");
});

test("lazy refresh updates the stored copy everywhere the video is", () => {
  const p = createPlaylist("Other") as { id: number };
  addItem(WATCH_LATER, meta(vid(1)));
  addItem(p.id, meta(vid(1)));
  refreshMeta({ ...meta(vid(1)), title: "New title", durationSeconds: 61 });
  for (const pl of [WATCH_LATER, p.id]) {
    const [i] = listItems(pl).items;
    assert.equal(i.title, "New title");
    assert.equal(i.durationSeconds, 61);
  }
});

test("concurrent adds: no duplicates, and the cap holds", async () => {
  await Promise.all(Array.from({ length: 20 }, async () => addItem(WATCH_LATER, meta(vid(1)))));
  assert.equal(getPlaylist(WATCH_LATER)?.count, 1);
  const results = await Promise.all(Array.from({ length: MAX_ITEMS + 30 }, async (_, i) => addItem(WATCH_LATER, meta(vid(1000 + i)))));
  assert.equal(results.filter((r) => r === "added").length, MAX_ITEMS - 1);
  assert.equal(results.filter((r) => r === "full").length, 31);
  assert.equal(getPlaylist(WATCH_LATER)?.count, MAX_ITEMS);
});

test("writes run in a transaction: one cannot start inside another", () => {
  addItem(WATCH_LATER, meta(vid(1)));
  const raw = getDb();
  raw.exec("BEGIN IMMEDIATE");
  assert.throws(() => addItem(WATCH_LATER, meta(vid(2))), /transaction|BEGIN/i, "nested writes are refused rather than interleaved");
  raw.exec("ROLLBACK");
  assert.equal(addItem(WATCH_LATER, meta(vid(2))), "added");
});
