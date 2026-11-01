import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSub, listSubs, removeSub } from "./store.ts";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-"));
  process.env.DATA_DIR = dir;
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
