import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSeconds, isoSeconds, parseDuration, timeAgo } from "./format.ts";

test("parseDuration", () => {
  assert.equal(parseDuration("PT4M5S"), "4:05");
  assert.equal(parseDuration("PT1H2M3S"), "1:02:03");
  assert.equal(parseDuration("PT45S"), "0:45");
});
test("timeAgo", () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  assert.equal(timeAgo("2026-10-30T00:00:00Z", now), "2 days ago");
});
test("formatSeconds", () => {
  assert.equal(formatSeconds(213), "3:33");
  assert.equal(formatSeconds(3723), "1:02:03");
});
test("isoSeconds", () => {
  assert.equal(isoSeconds("PT1H2M3S"), 3723);
  assert.equal(isoSeconds("PT45S"), 45);
  assert.equal(isoSeconds("P0D"), 0);
  assert.equal(isoSeconds(undefined), 0);
});
