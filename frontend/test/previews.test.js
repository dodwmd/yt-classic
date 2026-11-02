import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const el = (tag) => ({
  tag, children: [], listeners: {}, attrs: {}, hidden: false, className: "", textContent: "", style: {},
  setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); },
  addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] ?? []).filter((x) => x !== f); },
  fire(t, ev = {}) { for (const f of this.listeners[t] ?? []) f(ev); },
});
globalThis.document = { createElement: el, getElementById: () => null };
const images = [];
globalThis.Image = class { set src(v) { images.push(v); } };
const calls = [];
let reply = () => ({ status: 200, body: { tiles: TILES, duration: 213 } });
globalThis.fetch = async (url) => {
  calls.push(url);
  const r = reply(url);
  return { ok: r.status < 400, status: r.status, json: async () => r.body };
};
const { locate, valid, sheetUrl, previews, MAX_W } = await import("../public/js/previews.js");

// The descriptor a real 213 s video gets from the backend (320x180 tiles, 3x3 per sheet, 12 sheets).
const TILES = { w: 320, h: 180, cols: 3, rows: 3, count: 108, interval: 1.972, sheets: 12 };
const ID = "AAAAAAAAAAA";
const tick = () => new Promise((r) => setImmediate(r));

test("time -> sheet, column, row", () => {
  assert.deepEqual(locate(0, TILES), { sheet: 0, col: 0, row: 0 });
  assert.deepEqual(locate(1.97, TILES), { sheet: 0, col: 0, row: 0 }, "just before the second tile");
  assert.deepEqual(locate(1.973, TILES), { sheet: 0, col: 1, row: 0 });
  assert.deepEqual(locate(2 * 1.972 + 0.01, TILES), { sheet: 0, col: 2, row: 0 });
  assert.deepEqual(locate(3 * 1.972 + 0.01, TILES), { sheet: 0, col: 0, row: 1 }, "next row");
  assert.deepEqual(locate(9 * 1.972 + 0.01, TILES), { sheet: 1, col: 0, row: 0 }, "next sheet");
  assert.deepEqual(locate(17.8 * 1.972, TILES), { sheet: 1, col: 2, row: 2 });
});

test("edges: the end shows the last tile, bad times show the first", () => {
  assert.deepEqual(locate(213, TILES), { sheet: 11, col: 2, row: 2 }, "108 tiles: index 107 = sheet 11, tile 8");
  assert.deepEqual(locate(99999, TILES), { sheet: 11, col: 2, row: 2 });
  assert.deepEqual(locate(-5, TILES), { sheet: 0, col: 0, row: 0 });
  assert.deepEqual(locate(NaN, TILES), { sheet: 0, col: 0, row: 0 });
  const one = { cols: 10, rows: 10, count: 1, interval: 213 };
  assert.deepEqual(locate(200, one), { sheet: 0, col: 0, row: 0 }, "a single tile");
  const grid = { cols: 5, rows: 4, count: 45, interval: 2 };
  assert.deepEqual(locate(88, grid), { sheet: 2, col: 4, row: 0 }, "index 44 of a 20-per-sheet grid");
});

test("descriptor validation and URLs", () => {
  assert.equal(valid(TILES), true);
  for (const bad of [null, undefined, {}, { ...TILES, count: 0 }, { ...TILES, interval: NaN }, { ...TILES, w: "320" }, { ...TILES, cols: -1 }]) assert.equal(valid(bad), false);
  assert.equal(sheetUrl(ID, 3), `/api/video/${ID}/storyboard/3.jpg`);
});

function setup(src = `/stream/${ID}?q=720`) {
  const root = el("div"), bar = el("input");
  root.dataset = { src, duration: "213" };
  root.getBoundingClientRect = () => ({ left: 100, width: 640, bottom: 500 });
  bar.getBoundingClientRect = () => ({ left: 150, width: 400, top: 470 });
  calls.length = images.length = 0;
  previews(root, bar);
  const pv = root.children[0];
  return { root, bar, pv, img: pv.children[0], lab: pv.children[1] };
}

test("hover: fetches the descriptor once, shows a cropped tile with the time, and hides on leave", async () => {
  const c = setup();
  assert.deepEqual(calls, [`/api/video/${ID}/storyboard`]);
  assert.equal(c.pv.hidden, true);
  assert.equal(c.pv.attrs["aria-hidden"], "true");
  c.bar.fire("pointermove", { clientX: 350 }); // descriptor not here yet: nothing shown
  assert.equal(c.pv.hidden, true);
  await tick();
  c.bar.fire("pointerenter", {});
  assert.equal(calls.length, 1, "known now: no second request");
  c.bar.fire("pointermove", { clientX: 350 }); // halfway = 106.5 s = tile 54 = sheet 6, tile 0
  assert.equal(c.pv.hidden, false);
  assert.equal(c.lab.textContent, "1:46");
  assert.equal(c.img.style.backgroundImage, `url("/api/video/${ID}/storyboard/6.jpg")`);
  assert.equal(c.img.style.width, `${MAX_W}px`);
  assert.equal(c.img.style.height, "90px");
  assert.equal(c.img.style.backgroundSize, "480px 270px", "the whole sheet at the displayed scale");
  assert.equal(c.img.style.backgroundPosition, "0px 0px");
  assert.deepEqual(images, [`/api/video/${ID}/storyboard/6.jpg`], "the visible sheet is preloaded");
  assert.equal(c.pv.style.left, `${350 - 100 - 82}px`, "centred on the pointer");
  assert.equal(c.pv.style.bottom, `${500 - 470 + 6}px`, "above the bar");
  c.bar.fire("pointermove", { clientX: 351 });
  assert.equal(images.length, 1, "a sheet is requested once");
  c.bar.fire("pointerleave");
  assert.equal(c.pv.hidden, true);
});

test("the preview stays inside the player at both ends; positions outside the bar are clamped", async () => {
  const c = setup();
  await tick();
  c.bar.fire("pointermove", { clientX: 150 });
  assert.equal(c.pv.style.left, "0px");
  assert.equal(c.lab.textContent, "0:00");
  c.bar.fire("pointermove", { clientX: 5000 });
  assert.equal(c.pv.style.left, `${640 - 164}px`);
  assert.equal(c.lab.textContent, "3:33");
  assert.equal(c.img.style.backgroundImage, `url("/api/video/${ID}/storyboard/11.jpg")`);
  assert.equal(c.img.style.backgroundPosition, `${-2 * 160}px ${-2 * 90}px`);
  c.bar.fire("pointermove", { clientX: -40 });
  assert.equal(c.lab.textContent, "0:00");
});

test("touch: a drag shows it, lifting the finger hides it; a mouse button release keeps it", async () => {
  const c = setup();
  await tick();
  c.bar.fire("pointerdown", {});
  c.bar.fire("pointermove", { clientX: 300, pointerType: "touch" });
  assert.equal(c.pv.hidden, false);
  c.bar.fire("pointerup", { pointerType: "mouse" });
  assert.equal(c.pv.hidden, false);
  c.bar.fire("pointerup", { pointerType: "touch" });
  assert.equal(c.pv.hidden, true);
  c.bar.fire("pointermove", { clientX: 300 });
  c.bar.fire("pointercancel");
  assert.equal(c.pv.hidden, true);
});

test("chapter names join the label when the video has chapters", async () => {
  const c = setup();
  c.root.chapters = [{ start: 0, end: 60, title: "Intro" }, { start: 60, end: 213, title: "Main part" }];
  await tick();
  c.bar.fire("pointermove", { clientX: 350 });
  assert.equal(c.lab.textContent, "1:46 Main part");
  c.bar.fire("pointermove", { clientX: 160 });
  assert.equal(c.lab.textContent, "0:01 Intro", "the track starts a thumb radius in from the bar edge");
});

test("no storyboard (404) means never showing and never asking again; other failures are retried on the next hover", async () => {
  reply = () => ({ status: 404, body: { error: "x", code: "no-storyboard" } });
  const c = setup();
  await tick();
  c.bar.fire("pointermove", { clientX: 350 });
  c.bar.fire("pointerenter", {});
  assert.equal(c.pv.hidden, true);
  assert.equal(calls.length, 1);
  reply = () => ({ status: 502, body: { error: "x", code: "network" } });
  const d = setup();
  await tick();
  reply = () => ({ status: 200, body: { tiles: TILES } });
  d.bar.fire("pointerenter", {});
  await tick();
  d.bar.fire("pointermove", { clientX: 350 });
  assert.equal(d.pv.hidden, false, "the second hover got it");
  assert.equal(calls.length, 2);
});

test("a malformed descriptor and a missing duration show nothing", async () => {
  reply = () => ({ status: 200, body: { tiles: { ...TILES, count: 0 } } });
  const c = setup();
  await tick();
  c.bar.fire("pointermove", { clientX: 350 });
  assert.equal(c.pv.hidden, true);
  reply = () => ({ status: 200, body: { tiles: TILES } });
  const d = setup();
  d.root.dataset.duration = "0";
  await tick();
  d.bar.fire("pointermove", { clientX: 350 });
  assert.equal(d.pv.hidden, true);
  const e = setup("/stream/not-an-id");
  assert.equal(calls.length, 0, "no request without a valid video id");
  assert.equal(e.pv.hidden, true);
});

test("a new video while the pointer stays on the bar: the old tile goes and the new descriptor is fetched", async () => {
  reply = () => ({ status: 200, body: { tiles: TILES } });
  const c = setup();
  await tick();
  c.bar.fire("pointermove", { clientX: 350 });
  assert.equal(c.pv.hidden, false);
  c.root.dataset.src = "/stream/CCCCCCCCCCC?q=720";
  c.bar.fire("pointermove", { clientX: 351 });
  assert.equal(c.pv.hidden, true, "the previous video's tile is not left showing");
  assert.equal(calls.at(-1), "/api/video/CCCCCCCCCCC/storyboard", "no hover needed to look the new one up");
  await tick();
  c.bar.fire("pointermove", { clientX: 352 });
  assert.equal(c.pv.hidden, false);
  assert.equal(calls.length, 2, "one request per video, not per move");
  c.bar.fire("pointercancel");
  assert.equal(c.pv.hidden, true);
});

test("a new video in the same player (TV) uses its own descriptor", async () => {
  reply = () => ({ status: 200, body: { tiles: TILES } });
  const c = setup();
  await tick();
  c.root.dataset.src = "/stream/BBBBBBBBBBB?q=720";
  c.bar.fire("pointerenter", {});
  assert.equal(calls.at(-1), "/api/video/BBBBBBBBBBB/storyboard");
  c.bar.fire("pointermove", { clientX: 350 });
  assert.equal(c.pv.hidden, true, "not shown with the old video's tiles while the new one loads");
});

test("speed.js loads previews on the first pointer over the bar and survives the import failing", async () => {
  const src = readFileSync(new URL("../public/js/speed.js", import.meta.url), "utf8");
  assert.match(src, /import\("\.\/previews\.js"\)\.then\(\(m\) => m\.previews\(root, bar\)\)\.catch\(\(\) => \{\}\)/, "lazy, with a catch");
  assert.doesNotMatch(readFileSync(new URL("../public/js/player.js", import.meta.url), "utf8"), /previews/, "the eager player carries nothing for it");
  assert.doesNotMatch(readFileSync(new URL("../public/js/watch.js", import.meta.url), "utf8"), /previews/);
});
