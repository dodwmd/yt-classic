import { test } from "node:test";
import assert from "node:assert/strict";
import { logSafe } from "./http.ts";

test("logSafe removes line breaks and control characters and caps the length", () => {
  assert.equal(logSafe("GET /a\r\nINFO forged line\u001b[31m"), "GET /a  INFO forged line [31m");
  assert.ok(!/[\r\n]/.test(logSafe("a\nb\rc")));
  assert.equal(logSafe("x".repeat(500)).length, 203);
  assert.equal(logSafe("x".repeat(500), 10), "xxxxxxxxxx...");
  assert.equal(logSafe("/api/video/abc"), "/api/video/abc");
});
