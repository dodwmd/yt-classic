import { test } from "node:test";
import assert from "node:assert/strict";
import { envInt } from "./env.ts";

test("envInt falls back for missing, blank, non-numeric and negative values", () => {
  const log = console.error;
  console.error = () => {};
  try {
    delete process.env.X_TEST;
    assert.equal(envInt("X_TEST", 3), 3);
    for (const bad of ["", "abc", "-1", "1.5", "NaN"]) {
      process.env.X_TEST = bad;
      assert.equal(envInt("X_TEST", 3), 3, bad);
    }
    process.env.X_TEST = "0";
    assert.equal(envInt("X_TEST", 3), 0);
    process.env.X_TEST = "7";
    assert.equal(envInt("X_TEST", 3), 7);
  } finally {
    console.error = log;
    delete process.env.X_TEST;
  }
});
