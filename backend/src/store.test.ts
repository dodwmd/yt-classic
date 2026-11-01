import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SUBS, addSub, listSubs, removeSub } from "./store.ts";
import { closeDb } from "./db.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-"));
  process.env.DATA_DIR = dir;
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("subscriptions add/dedupe/remove", async () => {
  assert.deepEqual(await listSubs(), []);
  assert.equal(await addSub({ id: "UC1", title: "One" }), "added");
  assert.equal(await addSub({ id: "UC1", title: "One" }), "exists");
  await addSub({ id: "UC2", title: "Two" });
  assert.equal((await listSubs()).length, 2);
  await removeSub("UC1");
  assert.deepEqual(await listSubs(), [{ id: "UC2", title: "Two" }]);
});

test("parallel writes are all kept (no lost updates, no ENOENT)", async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => addSub({ id: `UC${i}`, title: `T${i}` })));
  assert.equal((await listSubs()).length, 10);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("a corrupt file is moved aside instead of breaking everything", async () => {
  writeFileSync(join(dir, "subscriptions.json"), '[{"id":"UC1","ti');
  assert.deepEqual(await listSubs(), []);
  assert.ok(readdirSync(dir).some((f) => f.includes(".corrupt-")));
  await addSub({ id: "UC2", title: "Two" }); // and writing works again
  assert.equal((await listSubs()).length, 1);
});

test("a wrong-shaped file is treated as corrupt", async () => {
  writeFileSync(join(dir, "subscriptions.json"), '{"not":"an array"}');
  assert.deepEqual(await listSubs(), []);
});

test("the subscription limit is enforced", async () => {
  for (let i = 0; i < MAX_SUBS; i++) await addSub({ id: `UC${i}`, title: `T${i}` });
  assert.equal(await addSub({ id: "UCextra", title: "x" }), "full");
  assert.equal((await listSubs()).length, MAX_SUBS);
  await removeSub("UC0");
  assert.equal(await addSub({ id: "UCextra", title: "x" }), "added");
});

test("order is insertion order and removing an unknown id is a no-op", async () => {
  for (const id of ["UCb", "UCa", "UCc"]) await addSub({ id, title: id });
  await removeSub("UCnone");
  assert.deepEqual((await listSubs()).map((s) => s.id), ["UCb", "UCa", "UCc"]);
});

test("an existing subscriptions.json is imported once and renamed", async () => {
  const subs = [{ id: "UC1", title: "One" }, { id: "UC2", title: "Two" }];
  writeFileSync(join(dir, "subscriptions.json"), JSON.stringify(subs));
  assert.deepEqual(await listSubs(), subs);
  assert.equal(existsSync(join(dir, "subscriptions.json")), false);
  assert.equal(readFileSync(join(dir, "subscriptions.json.migrated"), "utf8"), JSON.stringify(subs));
  await removeSub("UC1");
  closeDb(); // restart
  assert.deepEqual(await listSubs(), [{ id: "UC2", title: "Two" }]);
});

test("a re-appearing json file does not resurrect removed subscriptions", async () => {
  writeFileSync(join(dir, "subscriptions.json"), JSON.stringify([{ id: "UC1", title: "One" }]));
  await listSubs();
  await removeSub("UC1");
  closeDb();
  writeFileSync(join(dir, "subscriptions.json"), JSON.stringify([{ id: "UC1", title: "One" }]));
  assert.deepEqual(await listSubs(), []);
  assert.equal(existsSync(join(dir, "subscriptions.json")), false);
});

test("many parallel adds are all kept, duplicates are reported", async () => {
  const results = await Promise.all(Array.from({ length: 100 }, (_, i) => addSub({ id: `UC${i % 50}`, title: `T${i}` })));
  assert.equal(results.filter((r) => r === "added").length, 50);
  assert.equal(results.filter((r) => r === "exists").length, 50);
  assert.equal((await listSubs()).length, 50);
});
