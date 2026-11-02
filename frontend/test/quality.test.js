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

// A minimal DOM: just what the menu touches. canPlayType answers like a browser: per codec string, "" for unknown ones.
const SUPPORTED = (supports) => (type) => (supports.some((c) => type.includes(c)) ? "probably" : "");
function setup(opts = {}) {
  const { supports = ["avc1.640028"], fetched, res, ...attrs } = opts;
  const mk = (tag) => ({
    tag, canPlayType: SUPPORTED(supports), textContent: "", dataset: {}, attrs: {}, listeners: {},
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { this.listeners[t] = f; }, focus() { document.activeElement = this; },
  });
  const box = {
    ...mk("div"), kids: [],
    replaceChildren() { this.kids = []; }, append(...c) { this.kids.push(...c); },
    get firstChild() { return this.kids[0] ?? null; },
    contains(e) { return this.kids.includes(e); },
    querySelectorAll() { return this.kids.filter((k) => k.tag === "a"); },
    querySelector(sel) { const q = /data-q="(.+)"/.exec(sel)[1]; return this.kids.find((k) => k.dataset?.q === q) ?? null; },
  };
  globalThis.document = { getElementById: () => box, createElement: mk, activeElement: null };
  globalThis.screen = { width: 1920, height: 1080 };
  globalThis.devicePixelRatio = 1;
  const store = {};
  globalThis.localStorage = { setItem: (k, v) => (store[k] = v) };
  const urls = [], fetches = [];
  globalThis.history = { replaceState: (_s, _t, u) => urls.push(u) };
  globalThis.fetch = async (u) => { fetches.push(u); return { ok: !!fetched, json: async () => fetched }; };
  const calls = [];
  const player = { dataset: {} };
  qualityMenu({
    res: { video: { id: "abc" }, lang: "", quality: 720, auto: false, qualities: [360, 720, 1080], codecs: {}, tiersKnown: false, ...res },
    query: "q=720",
    stream: (q, c) => `/stream/abc?q=${q}${c && q > 1080 ? `&codecs=${c}` : ""}`, player, ready: () => true, restart: (t) => calls.push(t), now: () => 93.7, ...attrs,
  });
  return { box, store, urls, fetches, calls, player };
}
const labels = (box) => box.kids.filter((k) => k.tag).map((k) => `${k.textContent}${k.attrs["aria-current"] ? "*" : ""}`);

test("caps names the codecs the browser really claims and falls back to H.264", () => {
  setup({ supports: ["avc1.640028", "vp09.00.51.08"] });
  assert.equal(caps().codecs, "avc1,vp9", "AV1 is not claimed; VP9 level 5.1 is");
  setup({ supports: [] });
  assert.deepEqual(caps(), { codecs: "avc1", maxh: 1080 }, "a browser that says nothing is treated as H.264-only");
});

test("the menu marks the current tier with aria-current, restarts in place at the position and keeps the URL's t", () => {
  const t = setup({ fetched: null });
  assert.deepEqual(labels(t.box), ["360p", "720p*", "1080p", "Auto (max for screen)"]);
  t.box.kids.find((k) => k.textContent === "1080p").listeners.click({ preventDefault: () => (t.prevented = true) });
  assert.ok(t.prevented, "no page load");
  assert.equal(t.player.dataset.src, "/stream/abc?q=1080");
  assert.deepEqual(t.calls, [93]);
  assert.equal(t.store["yt.q"], 1080);
  assert.deepEqual(t.urls, ["/watch?v=abc&q=1080&t=93"]);
  assert.deepEqual(labels(t.box), ["360p", "720p", "1080p*", "Auto (max for screen)"]);
  t.box.kids.find((k) => k.dataset?.q === "auto").listeners.click({ preventDefault() {} });
  assert.equal(t.player.dataset.src, "/stream/abc?q=1080", "Auto = 1080 on a 1080p screen");
  assert.equal(t.store["yt.q"], "auto");
});

test("tiers the video really has arrive from /qualities, hidden ones stay hidden, and focus survives the redraw", async () => {
  const t = setup({
    supports: ["avc1.640028", "vp09.00.51.08"], // VP9 yes, AV1 no
    fetched: { tiersKnown: true, qualities: [720, 1080, 1440, 2160], codecs: { 720: ["avc1"], 1080: ["avc1"], 1440: ["av1"], 2160: ["vp9", "av1"] } },
  });
  document.activeElement = t.box.kids.find((k) => k.textContent === "720p"); // keyboard focus on a link
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(t.fetches, ["/api/video/abc/qualities?q=720"]);
  assert.deepEqual(labels(t.box), ["720p*", "1080p", "2160p", "Auto (max for screen)"], "1440p is AV1 only: hidden");
  assert.equal(document.activeElement?.textContent, "720p", "focus is restored on the rebuilt link");
});

test("a 4K stream request carries the codecs", () => {
  const t = setup({ supports: ["avc1.640028", "vp09.00.51.08"], res: { qualities: [720, 2160], codecs: { 2160: ["vp9"] } } });
  t.box.kids.find((k) => k.dataset?.q === "2160").listeners.click({ preventDefault() {} });
  assert.equal(t.player.dataset.src, "/stream/abc?q=2160&codecs=avc1,vp9");
});

test("no player yet (or live): the link is left alone so the page reloads at the new quality", () => {
  const t = setup({ ready: () => false });
  let prevented = false;
  t.box.kids.find((k) => k.textContent === "1080p").listeners.click({ preventDefault: () => (prevented = true) });
  assert.equal(prevented, false);
  assert.deepEqual(t.calls, []);
});
