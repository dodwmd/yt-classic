import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
globalThis.document = { getElementById: () => null };
const { split, indexAt, previousStart, initChapters, SEEK_GAP_MS } = await import("../public/js/chapters.js");

const links = (text, d = 3600) => split(text, d).filter((p) => typeof p !== "string").map((p) => [p.text, p.t]);

test("timestamps in prose become links with absolute seconds", () => {
  assert.deepEqual(links("Intro at 0:00, the demo at 12:34 and the end 1:02:03!", 7200), [["0:00", 0], ["12:34", 754], ["1:02:03", 3723]]);
  assert.deepEqual(split("see 1:30 now", 600), ["see ", { t: 90, text: "1:30" }, " now"]);
  assert.deepEqual(split("no times here", 600), ["no times here"]);
  assert.deepEqual(split("(2:15) Title\n3:00 - Next", 600).length, 5);
});

test("the shared timestamp cases (also run by the Android tests)", () => {
  const { cases } = JSON.parse(readFileSync(new URL("../../backend/test-fixtures/timestamp-links.json", import.meta.url), "utf8"));
  for (const c of cases) {
    const t0 = performance.now();
    assert.deepEqual(links(c.text, c.duration ?? NaN), c.links, c.name);
    assert.ok(performance.now() - t0 < 2000, `${c.name} is linear`);
  }
});

test("URLs, ports, longer tokens and impossible times stay text", () => {
  for (const t of ["https://x.com:8080/a", "http://host:1234", "https://y.tv/watch?t=1:30", "12:345", "1:02:03:04", "10:00pm", "ratio 16:9", "a@b.c:99:00", "1:75", "1:75:00", "v1.2:30", "file:12:30"]) {
    assert.deepEqual(links(t), [], t);
  }
});

test("times at or after the duration are not links", () => {
  assert.deepEqual(links("1:00 2:00 3:00", 150), [["1:00", 60], ["2:00", 120]]);
  assert.deepEqual(links("0:00", 0), []);
  assert.deepEqual(links("0:00", NaN), []);
});

test("indexAt and previousStart follow the absolute position", () => {
  const ch = [{ start: 0 }, { start: 60 }, { start: 300 }];
  assert.deepEqual([0, 59, 60, 299, 300, 9999].map((t) => indexAt(ch, t)), [0, 0, 1, 1, 2, 2]);
  assert.equal(indexAt([{ start: 10 }], 5), -1);
  assert.equal(previousStart(ch, 70), 60, "well into a chapter: restart this one");
  assert.equal(previousStart(ch, 62), 0, "just began: go to the previous one");
  assert.equal(previousStart(ch, 20), 0);
});

test("pathological text is linear", () => {
  const t0 = performance.now();
  split("1:".repeat(100000) + "0:".repeat(100000) + "9".repeat(100000), 3600);
  assert.ok(performance.now() - t0 < 2000);
});

// A small DOM: enough for initChapters to build links and rows, and for tests to click and press keys.
function dom() {
  const mk = (tag) => ({ tag, children: [], attrs: {}, listeners: {}, hidden: false, className: "", textContent: "",
    append(...c) { this.children.push(...c.map((x) => (typeof x === "string" ? { text: x } : x))); },
    replaceChildren(...c) { this.children = c; },
    addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
    setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; },
    fire(t, e = {}) { for (const f of this.listeners[t] ?? []) f({ defaultPrevented: false, button: 0, preventDefault() { this.defaultPrevented = true; }, ...e }); } });
  const els = { "#desc": mk("div"), "#ch-list": mk("ol"), "#ch-name": mk("span"), "#ch-sum": mk("summary"), "#chapters": mk("details"), "#player": mk("div") };
  els["#chapters"].hidden = true;
  const doc = { listeners: {}, getElementById: () => null, querySelector: (s) => els[s], createElement: mk, createTextNode: (t) => ({ text: t }), addEventListener: (t, f) => (doc.listeners[t] ??= []).push(f) };
  globalThis.document = doc;
  globalThis.location = { assigned: [], assign(u) { this.assigned.push(u); } };
  return { els, doc, press: (e) => { for (const f of doc.listeners.keydown ?? []) f({ key: "]", ...e }); } };
}
const CH = [{ start: 0, title: "Intro" }, { start: 60, title: "<img src=x onerror=alert(1)>" }, { start: 120, title: "End" }];
function setup(over = {}) {
  const d = dom();
  d.els["#desc"].textContent = "Go to 1:00 or https://x.com:8080 now";
  const video = mk2();
  let pos = 0, clock = 0;
  const seeks = [];
  const c = over.noPlayer ? undefined : Object.assign(() => pos, { seek: (t) => seeks.push(t) });
  initChapters({ v: { id: "dQw4w9WgXcQ", durationSeconds: 300 }, chapters: CH, start: 0, player: { get now() { return c; }, dataset: { start: "0" }, querySelector: () => video }, now: () => clock });
  return { ...d, video, seeks, setPos: (p) => (pos = p), tick: (ms = SEEK_GAP_MS + 1) => (clock += ms) };
}
function mk2() {
  const l = {};
  return { addEventListener: (t, f) => (l[t] ??= []).push(f), fire: (t) => (l[t] ?? []).forEach((f) => f()) };
}

test("initChapters: links are real URLs, a plain click seeks, modified clicks and no-player clicks go to the browser", () => {
  const t = setup();
  const a = t.els["#desc"].children.find((x) => x.tag === "a");
  assert.equal(a.href, "/watch?v=dQw4w9WgXcQ&t=60");
  assert.equal(t.els["#desc"].children.filter((x) => x.text !== undefined).map((x) => x.text).join(""), "Go to  or https://x.com:8080 now", "text around the link stays text nodes");
  let prevented = false;
  a.fire("click", { preventDefault() { prevented = true; } });
  assert.deepEqual(t.seeks, [60]);
  assert.ok(prevented);
  for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    t.tick();
    prevented = false;
    a.fire("click", { ...mod, preventDefault() { prevented = true; } });
    assert.ok(!prevented, JSON.stringify(mod));
  }
  assert.deepEqual(t.seeks, [60], "modified clicks never seek here");
});

test("initChapters: with no player a click is not swallowed; a chapter row reopens the page at that time", () => {
  const t = setup({ noPlayer: true });
  const a = t.els["#desc"].children.find((x) => x.tag === "a");
  let prevented = false;
  a.fire("click", { preventDefault() { prevented = true; } });
  assert.ok(!prevented, "the browser follows the real link");
  const row = t.els["#ch-list"].children[2].children[0];
  row.fire("click");
  assert.deepEqual(location.assigned, ["/watch?v=dQw4w9WgXcQ&t=120"]);
});

test("initChapters: rows seek, the title is text, the current row follows the absolute time including boundaries", () => {
  const t = setup();
  const rows = t.els["#ch-list"].children.map((li) => li.children[0]);
  assert.equal(rows[1].children[1].text, " <img src=x onerror=alert(1)>", "a hostile title is a text node");
  assert.equal(t.els["#ch-sum"].textContent, "Chapters (3)");
  assert.equal(t.els["#chapters"].hidden, false);
  const cur = () => rows.findIndex((r) => r.attrs["aria-current"] === "true");
  assert.equal(cur(), 0);
  for (const [pos, want] of [[59.999, 0], [60, 1], [119.5, 1], [120, 2], [299.9, 2], [0.4, 0]]) {
    t.setPos(pos);
    t.video.fire("timeupdate");
    assert.equal(cur(), want, `at ${pos}`);
    assert.equal(rows.filter((r) => r.attrs["aria-current"]).length, 1);
  }
  assert.equal(t.els["#ch-name"].textContent, "Intro");
  rows[2].fire("click");
  assert.deepEqual(t.seeks, [120]);
});

test("[ and ] jump between chapters, but not while typing, with modifiers, on key repeat or faster than the seek gap", () => {
  const t = setup();
  t.setPos(70);
  t.press({ key: "]" });
  assert.deepEqual(t.seeks, [120]);
  t.tick();
  t.press({ key: "[" });
  assert.deepEqual(t.seeks, [120, 60], "70 s is well into chapter 2: restart it");
  t.tick();
  for (const e of [{ target: { matches: () => true } }, { ctrlKey: true }, { isComposing: true }, { repeat: true }, { key: "x" }]) t.press(e);
  assert.deepEqual(t.seeks, [120, 60], "ignored");
  t.press({ key: "]" }); // no tick: within the gap since the last seek? the last seek was before the tick, so this one is allowed
  t.press({ key: "]" });
  assert.equal(t.seeks.length, 3, "a second seek inside the gap is dropped");
  t.setPos(200);
  t.tick();
  t.press({ key: "]" });
  assert.equal(t.seeks.length, 3, "no chapter after the last one");
});

test("watch.js loads chapters.js lazily and a failure while initialising it cannot break the page", () => {
  const src = readFileSync(new URL("../public/js/watch.js", import.meta.url), "utf8");
  assert.match(src, /import\("\.\/chapters\.js"\)\.then\(\(m\) => m\.initChapters\([^\n]*\)\)\.catch\(/);
});
