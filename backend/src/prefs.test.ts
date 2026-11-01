import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getDb } from "./db.ts";
import { getPrefs, parsePrefs, setPrefs } from "./prefs.ts";

let tmp = "";
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "yt-prefs-"));
  process.env.DATA_DIR = tmp;
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("prefs: defaults, partial updates, stored under feed.* in meta", () => {
  assert.deepEqual(getPrefs(), { hideWatched: false, shorts: "show", live: "show" });
  const p = parsePrefs({ hideWatched: "true", shorts: "hide" });
  assert.ok("update" in p);
  assert.deepEqual(setPrefs(p.update), { hideWatched: true, shorts: "hide", live: "show" });
  const rows = getDb().prepare("SELECT key, value FROM meta WHERE key LIKE 'feed.%' ORDER BY key").all();
  assert.deepEqual(rows.map((r) => [r.key, r.value]), [["feed.hideWatched", "1"], ["feed.shorts", "hide"]]);
});

test("prefs: a corrupt stored value falls back to the default", () => {
  getDb().prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('feed.live', 'garbage')").run();
  assert.equal(getPrefs().live, "show");
});

test("prefs: whitelist and validation", () => {
  const cases: Record<string, string>[] = [{ evil: "1" }, { shorts: "yes" }, { hideWatched: "2" }, { live: "" }, {}, { session_secret: "x" }, { "feed.live": "hide" }];
  for (const bad of cases) {
    assert.ok("error" in parsePrefs(bad), JSON.stringify(bad));
  }
  assert.ok("update" in parsePrefs({ live: "hide", hideWatched: "0" }));
});
