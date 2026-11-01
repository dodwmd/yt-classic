import { test } from "node:test";
import assert from "node:assert/strict";
import { ffmpegArgs, parseQuality, parseStart } from "./dlp.ts";

test("parseQuality / parseStart", () => {
  assert.equal(parseQuality("1080"), 1080);
  assert.equal(parseQuality("999"), 720);
  assert.equal(parseQuality(null), 720);
  assert.equal(parseStart("90"), 90);
  assert.equal(parseStart("-5"), 0);
  assert.equal(parseStart("abc"), 0);
});

test("ffmpegArgs maps video+audio and seeks each input", () => {
  const a = ffmpegArgs(["V", "A"], 30);
  assert.equal(a.filter((x) => x === "-ss").length, 2);
  assert.ok(a.join(" ").includes("-map 0:v:0 -map 1:a:0"));
  assert.ok(a.join(" ").includes("-movflags frag_keyframe+empty_moov"));
  assert.ok(!ffmpegArgs(["M"], 0).includes("-ss"));
  assert.ok(!ffmpegArgs(["M"], 0).includes("-map"));
});

import { formatSelector, parseLang } from "./dlp.ts";
test("parseLang / formatSelector prefer the requested audio language", () => {
  assert.equal(parseLang("pt"), "pt");
  assert.equal(parseLang("../x"), "en");
  assert.equal(parseLang(null), "en");
  const sel = formatSelector(720, "en");
  assert.ok(sel.indexOf("language^=en") < sel.indexOf("ba[ext=m4a]/"));
  assert.ok(sel.includes("/b[height<=720]"));
});
