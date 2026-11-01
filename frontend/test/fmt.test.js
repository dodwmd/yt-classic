import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSeconds, formatViews, join, timeAgo, viewsText } from "../public/js/fmt.js";

test("formatSeconds", () => {
  assert.equal(formatSeconds(65), "1:05");
  assert.equal(formatSeconds(213), "3:33");
  assert.equal(formatSeconds(3723), "1:02:03");
  assert.equal(formatSeconds(0), "0:00");
});

test("timeAgo boundaries", () => {
  const now = Date.parse("2027-01-01T00:00:00Z");
  const ago = (days) => timeAgo(new Date(now - days * 86400_000).toISOString(), now);
  assert.equal(ago(2), "2 days ago");
  assert.equal(ago(364), "11 months ago"); // not "12 months"
  assert.equal(ago(365), "1 year ago");
  assert.equal(ago(0.0001), "just now");
  assert.equal(timeAgo("", now), "");
  assert.equal(timeAgo(undefined, now), "");
  assert.equal(timeAgo("garbage", now), "");
});

test("views and joins", () => {
  assert.equal(formatViews("1234"), "1,234 views");
  assert.equal(formatViews(5), "5 views");
  assert.equal(formatViews(""), "");
  assert.equal(formatViews(undefined), "");
  assert.equal(viewsText("1.2M"), "1.2M views");
  assert.equal(viewsText("3K watching"), "3K watching");
  assert.equal(join("a", "", undefined, "b"), "a · b");
});
