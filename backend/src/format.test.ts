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

import { formatViews, viewsText } from "./format.ts";
test("format boundaries", () => {
  const now = Date.parse("2027-01-01T00:00:00Z");
  const ago = (days: number) => timeAgo(new Date(now - days * 86400_000).toISOString(), now);
  assert.equal(ago(364), "11 months ago"); // not "12 months"
  assert.equal(ago(365), "1 year ago");
  assert.equal(ago(0.0001), "just now");
  assert.equal(timeAgo("", now), "");
  assert.equal(timeAgo("garbage", now), "");
  assert.equal(formatViews(""), "");
  assert.equal(formatViews("1234"), "1,234 views");
  assert.equal(parseDuration("P0D"), "");
  assert.equal(parseDuration("P1DT2H"), "26:00:00");
  assert.equal(isoSeconds("P1DT2H"), 93600);
  assert.equal(viewsText("1.2M"), "1.2M views");
  assert.equal(viewsText("3K watching"), "3K watching");
});
