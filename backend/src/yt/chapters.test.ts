import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChapters, timestampLine, MAX_CHAPTERS, MAX_TITLE } from "./chapters.ts";

const D = 3600 * 2;
const starts = (d: string, dur = D) => parseChapters(d, dur).map((c) => c.start);

test("a typical description list becomes chapters with ends", () => {
  const desc = `Thanks for watching! Subscribe: https://example.com:8080/x\n\nChapters:\n0:00 Intro\n1:02 - Setting up\n10:15 – The main part\n1:02:03 Wrap up\n\nFollow me on twitter`;
  assert.deepEqual(parseChapters(desc, D), [
    { start: 0, end: 62, title: "Intro" },
    { start: 62, end: 615, title: "Setting up" },
    { start: 615, end: 3723, title: "The main part" },
    { start: 3723, end: D, title: "Wrap up" },
  ]);
});

test("formats: brackets, bullets, emoji, CRLF, CR, hours, leading zeros", () => {
  assert.deepEqual(starts("▶ 00:00 Intro\r\n• (2:15) Two\r\n[1:00:00] Three\r\n- 1:30:05: Four"), [0, 135, 3600, 5405]);
  assert.deepEqual(starts("0:00 a\r1:00 b\r2:00 c"), [0, 60, 120]);
  assert.deepEqual(starts("0:00 a\n\n1:00 b\n   \n2:00 c"), [0, 60, 120], "blank lines do not end the list");
  assert.equal(parseChapters("00:00 🎬 Intro 🚀\n1:00 b\n2:00 c", D)[0].title, "🎬 Intro 🚀");
});

test("URLs, ports and longer tokens are not timestamps", () => {
  for (const l of ["https://x.com:8080 site", "http://localhost:3000", "12:345 nope", "1:02:03:04 nope", "10:00pm show", "0:00", "0:00 - ", "see 0:00 Intro", "1:75 bad seconds", "1:75:00 x", "ratio 16:9"]) {
    assert.equal(timestampLine(l), null, l);
  }
  assert.deepEqual(parseChapters("0:00 A\n1:00 B\nhttps://x.com:8080\n2:00 C", D), [], "text ends the run");
});

test("YouTube's rule: starts at 0:00, ascending, at least three entries", () => {
  assert.deepEqual(starts("0:00 a\n1:00 b"), [], "only two");
  assert.deepEqual(starts("0:05 a\n1:00 b\n2:00 c"), [], "does not start at 0:00");
  assert.deepEqual(starts("0:00 a\n1:00 b\n1:00 c\n2:00 d"), [], "duplicate time breaks the run");
  assert.deepEqual(starts("0:00 a\n5:00 b\n4:00 c\n6:00 d"), [], "descending breaks the run");
  assert.deepEqual(starts("1:00 intro mention\nlater\n0:00 a\n1:00 b\n2:00 c"), [0, 60, 120], "a stray timestamp in text is skipped");
  assert.deepEqual(starts("0:00 a\n1:00 b\n0:00 a\n1:00 b\n2:00 c\n3:00 d"), [0, 60, 120, 180], "a later complete list wins over a short earlier one");
  assert.deepEqual(parseChapters("", D), []);
  assert.deepEqual(parseChapters("0:00 a\n1:00 b\n2:00 c", undefined), []);
  assert.deepEqual(parseChapters("0:00 a\n1:00 b\n2:00 c", 0), []);
});

test("times at or after the duration are dropped", () => {
  assert.deepEqual(parseChapters("0:00 a\n1:00 b\n2:00 c\n3:00 d", 150).map((c) => c.start), [0, 60, 120]);
  assert.deepEqual(parseChapters("0:00 a\n1:00 b\n2:00 c\n3:00 d", 150).at(-1)?.end, 150);
  assert.deepEqual(parseChapters("0:00 a\n1:00 b\n2:00 c", 120), [], "only two remain");
});

test("titles are plain text, cut to 100 characters, and the list to 100 chapters", () => {
  const t = parseChapters(`0:00 ${"x".repeat(500)}\n1:00 a\u0000b‮\tc\n2:00 🚀`, D);
  assert.equal(t[0].title.length, MAX_TITLE);
  assert.equal(t[1].title, "a b c");
  assert.equal(parseChapters(`0:00 ${"🚀".repeat(300)}\n1:00 b\n2:00 c`, D)[0].title, "🚀".repeat(MAX_TITLE));
  const many = Array.from({ length: 150 }, (_, i) => `${Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")} t${i}`).join("\n");
  assert.equal(parseChapters(many, D).length, MAX_CHAPTERS);
  assert.equal(parseChapters(many, D)[99].end, 100);
});

test("pathological input is linear", () => {
  const big = ("0:0".repeat(20000) + "\n").repeat(20) + "9".repeat(200000) + ":".repeat(100000) + "\n" + " ".repeat(300000) + "0:00 a";
  const t0 = performance.now();
  assert.deepEqual(parseChapters(big, D), []);
  assert.ok(performance.now() - t0 < 2000);
});

test("bidi controls and object replacement characters never reach a title; NEL, LS and PS separate lines", () => {
  const t = parseChapters("0:00 a⁦b⁩c؜d￼e‮f\n1:00 b\n2:00 c", D);
  assert.equal(t[0].title, "a b c d e f");
  assert.deepEqual(starts("0:00 a\u00851:00 b 2:00 c 3:00 d"), [0, 60, 120, 180]);
});
