import { test } from "node:test";
import assert from "node:assert/strict";
import { isoSeconds } from "./format.ts";

test("isoSeconds", () => {
  assert.equal(isoSeconds("PT1H2M3S"), 3723);
  assert.equal(isoSeconds("PT45S"), 45);
  assert.equal(isoSeconds("P1DT2H"), 93600);
  assert.equal(isoSeconds("P0D"), 0);
  assert.equal(isoSeconds("garbage"), 0);
  assert.equal(isoSeconds(undefined), 0);
});
