import { test } from "node:test";
import assert from "node:assert/strict";
import { autoTier, caps, playable, qualityMenu } from "../public/js/quality.js";

const ALL = [360, 720, 1080, 1440, 2160];
const codecs = { 360: ["avc1", "vp9"], 720: ["avc1", "vp9"], 1080: ["avc1", "vp9"], 1440: ["vp9", "av1"], 2160: ["vp9", "av1"] };

test("tiers whose codecs the browser lacks are hidden", () => {
  assert.deepEqual(playable(ALL, codecs, ["avc1"]), [360, 720, 1080]);
  assert.deepEqual(playable(ALL, codecs, ["avc1", "av1"]), ALL);
  assert.deepEqual(playable([720, 2160], {}, ["avc1"]), [720, 2160], "no hint: shown");
});

test("Auto picks the tallest playable tier that fits the screen", () => {
  assert.equal(autoTier([360, 720, 1080, 2160], 1440), 1080);
  assert.equal(autoTier([360, 720, 1080, 2160], 2160), 2160);
  assert.equal(autoTier([720, 1080], 480), 720, "nothing fits: the lowest, not nothing");
  assert.equal(autoTier([360, 720], 100), 360);
});

// A minimal DOM: just what the menu touches.
function setup(attrs) {
  const box = { kids: [], replaceChildren() { this.kids = []; }, append(...c) { this.kids.push(...c); }, get firstChild() { return this.kids[0] ?? null; } };
  globalThis.document = {
    getElementById: () => box,
    createElement: (tag) => ({ tag, canPlayType: () => "", textContent: "", listeners: {}, addEventListener(t, f) { this.listeners[t] = f; } }),
  };
  globalThis.screen = { width: 1920, height: 1080 };
  globalThis.devicePixelRatio = 1;
  const store = {};
  globalThis.localStorage = { setItem: (k, v) => (store[k] = v) };
  const url = [];
  globalThis.history = { replaceState: (_s, _t, u) => url.push(u) };
  const calls = [];
  const player = { dataset: {} };
  qualityMenu({
    id: "abc", lang: "", quality: 720, auto: false, qualities: [360, 720, 1080, 2160], codecs: { 2160: ["vp9"] },
    stream: (q) => `/stream/abc?q=${q}`, player, ready: () => true, restart: (t) => calls.push(t), now: () => 93.7, ...attrs,
  });
  return { box, store, url, calls, player };
}
const labels = (box) => box.kids.filter((k) => k.tag).map((k) => `${k.tag}:${k.textContent}`);

test("the menu lists tiers and Auto, marks the current one and restarts in place at the current position", () => {
  const t = setup();
  assert.deepEqual(caps(), { codecs: "avc1", maxh: 1080 }, "a browser that says nothing is treated as H.264-only");
  assert.deepEqual(labels(t.box), ["a:360p", "b:720p", "a:1080p", "a:Auto"], "2160 needs vp9, which this stub browser lacks");
  const click = t.box.kids.find((k) => k.textContent === "1080p");
  let prevented = false;
  click.listeners.click({ preventDefault: () => (prevented = true) });
  assert.ok(prevented, "no page load");
  assert.equal(t.player.dataset.src, "/stream/abc?q=1080");
  assert.deepEqual(t.calls, [93.7]);
  assert.equal(t.store["yt.q"], 1080);
  assert.deepEqual(t.url, ["/watch?v=abc&q=1080"]);
  assert.deepEqual(labels(t.box), ["a:360p", "a:720p", "b:1080p", "a:Auto"]);
  t.box.kids.find((k) => k.textContent === "Auto").listeners.click({ preventDefault() {} });
  assert.equal(t.player.dataset.src, "/stream/abc?q=1080", "Auto = 1080 on a 1080p screen");
  assert.equal(t.store["yt.q"], "auto");
});
