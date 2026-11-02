import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "./db.ts";
import { addUnits, fallbackAllowed, fallbackRemaining, resetQuotaForTests, unitsToday } from "./quota.ts";

test("daily Data API counters survive a restart, so the fallback cap is not reset by it", () => {
  const dir = mkdtempSync(join(tmpdir(), "yt-quota-"));
  process.env.DATA_DIR = dir;
  process.env.SEARCH_FALLBACK_MAX = "3";
  try {
    resetQuotaForTests();
    addUnits(100);
    addUnits(1);
    assert.equal(fallbackAllowed(), true);
    assert.equal(fallbackAllowed(), true);
    closeDb();
    resetQuotaForTests(); // the restart
    assert.equal(unitsToday(), 101);
    assert.equal(fallbackRemaining(), 1);
    assert.equal(fallbackAllowed(), true);
    assert.equal(fallbackAllowed(), false, "the third and fourth tries are over the cap of 3");
    resetQuotaForTests();
    assert.equal(fallbackRemaining(), 0);
  } finally {
    delete process.env.SEARCH_FALLBACK_MAX;
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
