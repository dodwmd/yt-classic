import { test } from "node:test";
import assert from "node:assert/strict";

const el = (tag) => ({
  tag, children: [], listeners: {}, attrs: {}, hidden: false, className: "", value: "", textContent: "",
  setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); },
  before(n) { this.before_ = n; }, addEventListener(t, f) { this.listeners[t] = f; },
  querySelector() { return this.fs; },
});
globalThis.HTMLInputElement = class {};
globalThis.HTMLSelectElement = class {};
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v) };
const docListeners = {};
globalThis.document = { createElement: el, addEventListener: (t, f) => (docListeners[t] = f) };
const { SPEEDS, clampRate, zone, doubleTap, accumulator, speedControls, typing } = await import("../public/js/speed.js");

test("rates outside the list fall back to 1x", () => {
  assert.deepEqual(SPEEDS, [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
  assert.equal(clampRate("1.5"), 1.5);
  for (const bad of [null, "", "abc", 3, 0.1, NaN]) assert.equal(clampRate(bad), 1);
});

test("zones split the video in thirds", () => {
  assert.deepEqual([0, 0.32, 0.34, 0.5, 0.66, 0.68, 1].map(zone), [-1, -1, 0, 0, 0, 1, 1]);
});

test("double tap needs the same side within 300 ms", () => {
  const d = doubleTap();
  assert.equal(d(1, 0), false);
  assert.equal(d(1, 300), true);
  assert.equal(d(1, 400), false, "a used-up pair starts over");
  assert.equal(d(-1, 500), false, "other side is a new first tap");
  assert.equal(d(-1, 801), false, "too slow");
});

test("a run adds a step per tap on its side, restarts on the other side and ends when finished", () => {
  const a = accumulator();
  assert.equal(a.open(1), false);
  assert.equal(a.add(1, 100).d, 10);
  assert.equal(a.add(1, 999).d, 20);
  assert.equal(a.open(1), true);
  assert.equal(a.open(-1), false);
  assert.equal(a.add(-1, 999).d, -10, "the other side starts the total over");
  assert.equal(a.add(-1, 999).from, 100);
  a.finish();
  assert.equal(a.open(-1), false);
  assert.deepEqual([a.add(-1, 50).from, a.add(-1, 50).d], [50, -20]);
});

test("keys typed into fields or composed by an IME are not shortcuts", () => {
  const t = (sel) => ({ matches: (q) => q.includes(sel) });
  assert.equal(typing({ target: t("textarea") }), true);
  assert.equal(typing({ target: t("[contenteditable]") }), true);
  assert.equal(typing({ target: t("input") }), true);
  assert.equal(typing({ target: {}, isComposing: true }), true);
  assert.equal(typing({ target: { matches: () => false } }), false);
  assert.equal(typing({ target: null }), false);
});

function setup(t, rate) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const root = el("div"); root.fs = el("button");
  const v = el("video");
  v.getBoundingClientRect = () => ({ left: 0, width: 300 });
  if (rate) store["yt.rate"] = rate;
  let tap, toggles = 0; const seeks = [];
  speedControls({ root, v, seek: (s) => seeks.push(s), now: () => 100, setTap: (f) => (tap = f), toggle: () => toggles++ });
  const sel = root.fs.before_;
  return { root, v, sel, seeks, tap, toggles: () => toggles, status: () => root.children.at(-1), fx: () => root.children.at(-2) };
}
const touch = (x, timeStamp) => ({ clientX: x, timeStamp, pointerType: "touch" });

test("controls: rate is applied, persisted, reapplied on load and announced", (t) => {
  const c = setup(t, "1.5");
  assert.equal(c.v.playbackRate, 1.5);
  assert.equal(c.v.defaultPlaybackRate, 1.5);
  c.v.playbackRate = 1; // a new source reset it
  c.v.listeners.loadedmetadata();
  assert.equal(c.v.playbackRate, 1.5);
  docListeners.keydown({ key: ">", target: {} });
  assert.equal(c.v.playbackRate, 1.75);
  assert.equal(store["yt.rate"], "1.75");
  assert.equal(c.status().textContent, "Speed 1.75×");
  assert.equal(c.status().attrs.role, "status");
  assert.equal(c.status().hidden, false, "the live region is always rendered");
  assert.equal(c.fx().attrs["aria-hidden"], "true");
  docListeners.keydown({ key: "<", target: {}, ctrlKey: true });
  docListeners.keydown({ key: "<", target: { matches: () => true } }); // typing in a textarea
  docListeners.keydown({ key: "<", target: {}, isComposing: true });
  assert.equal(c.v.playbackRate, 1.75);
});

test("a touch single tap toggles after 300 ms; the middle toggles at once; a mouse click at once", (t) => {
  const c = setup(t);
  c.tap({ clientX: 150, timeStamp: 0, pointerType: "touch" });
  assert.equal(c.toggles(), 1);
  c.tap(touch(290, 1000));
  assert.equal(c.toggles(), 1);
  t.mock.timers.tick(300);
  assert.equal(c.toggles(), 2);
  c.tap({ clientX: 290, timeStamp: 5000, pointerType: "mouse" });
  assert.equal(c.toggles(), 3);
  assert.deepEqual(c.seeks, []);
});

test("three quick taps on one side: +20, no toggle, one seek", (t) => {
  const c = setup(t);
  c.tap(touch(10, 0)); c.tap(touch(10, 100)); c.tap(touch(10, 200));
  assert.equal(c.fx().textContent, "-20s");
  assert.equal(c.status().textContent, "Rewind 20 seconds");
  t.mock.timers.tick(1000);
  assert.equal(c.toggles(), 0);
  assert.deepEqual(c.seeks, [80]);
});

test("taps on the other side start the total over; the pair after a finished run starts a new one", (t) => {
  const c = setup(t);
  c.tap(touch(10, 0)); c.tap(touch(10, 100)); // -10
  c.tap(touch(290, 200)); c.tap(touch(290, 300)); // right side double: reset to +10
  assert.equal(c.fx().textContent, "+10s");
  t.mock.timers.tick(700);
  assert.deepEqual(c.seeks, [110]);
  c.tap(touch(290, 5000)); c.tap(touch(290, 5100));
  t.mock.timers.tick(700);
  assert.deepEqual(c.seeks, [110, 110]);
});

test("a mouse double click seeks once on its side; a touch double tap is not seeked twice", (t) => {
  const c = setup(t);
  c.v.listeners.dblclick({ clientX: 290, timeStamp: 10000 });
  t.mock.timers.tick(700);
  assert.deepEqual(c.seeks, [110]);
  c.v.listeners.dblclick({ clientX: 150, timeStamp: 20000 }); // middle: nothing
  c.tap(touch(10, 30000)); c.tap(touch(10, 30100));
  c.v.listeners.dblclick({ clientX: 10, timeStamp: 30150 }); // the browser's own dblclick after the touch pair
  t.mock.timers.tick(700);
  assert.deepEqual(c.seeks, [110, 90]);
});
