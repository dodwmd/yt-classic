import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addSub, listSubs, removeSub } from "./store.ts";

test("subscriptions add/dedupe/remove", async () => {
  process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "yt-"));
  assert.deepEqual(await listSubs(), []);
  await addSub({ id: "UC1", title: "One" });
  await addSub({ id: "UC1", title: "One" });
  await addSub({ id: "UC2", title: "Two" });
  assert.equal((await listSubs()).length, 2);
  await removeSub("UC1");
  assert.deepEqual(await listSubs(), [{ id: "UC2", title: "Two" }]);
});
