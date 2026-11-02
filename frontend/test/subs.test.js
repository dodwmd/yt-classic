import { test } from "node:test";
import assert from "node:assert/strict";

const el = (tag) => {
  const e = {
    tag, children: [], listeners: {}, attrs: {}, hidden: false, className: "", value: "", textContent: "",
    setAttribute(k, v) { this.attrs[k] = v; }, append(...c) { this.children.push(...c); },
    before(...n) { this.before_ = n; }, addEventListener(t, f) { (this.listeners[t] ??= []).push(f); },
    fire(t, ev = {}) { for (const f of this.listeners[t] ?? []) f(ev); },
  };
  return e;
};
const store = {};
globalThis.localStorage = { getItem: (k) => store[k] ?? null, setItem: (k, v) => (store[k] = v) };
const docListeners = [];
globalThis.document = { getElementById: () => null, createElement: el, addEventListener: (t, f) => docListeners.push([t, f]) };
const key = (e) => docListeners.filter(([t]) => t === "keydown").forEach(([, f]) => f({ target: {}, ...e }));
const { parseVtt, activeAt, subtitles } = await import("../public/js/subs.js");

test("cue timing: mm:ss.mmm, hh:mm:ss.mmm, comma, cue settings, identifiers", () => {
  const c = parseVtt("WEBVTT\n\n1\n00:01.500 --> 00:03.000 align:start position:0%\nhello\n\n01:00:01.250 --> 01:00:02,5\nlate\n");
  assert.deepEqual(c, [{ s: 1.5, e: 3, t: "hello" }, { s: 3601.25, e: 3602.5, t: "late" }]);
});

test("multiline cues, tags, entities, CRLF; NOTE/STYLE/REGION blocks and empty cues are skipped", () => {
  const vtt = "\uFEFFWEBVTT - title\r\nKind: captions\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\nNOTE a comment\r\n00:00.000 --> 00:01.000\r\n\r\nREGION\r\nid:x\r\n\r\n" +
    "00:00:01.000 --> 00:00:02.000\r\n<v Bob><b>Hi</b> <i>there</i> &amp; <c.yellow>you</c>\r\n<00:00:01.500>second &lt;line&gt; &apos;q&apos; &#x27;h&#x27; &#39;d&#39; &#8364; &#0; &#xD800;\r\n\r\n" +
    "00:02.000 --> 00:03.000\r\n<c></c>\r\n\r\n00:03.000 --> 00:04.000\none\ntwo\nthree\n\n00:05.000 --> 00:04.000\nbackwards\n\n00:61.000 --> 00:62.000\nbad minutes\n";
  assert.deepEqual(parseVtt(vtt), [{ s: 1, e: 2, t: "Hi there & you\nsecond <line> 'q' 'h' 'd' \u20ac" }, { s: 3, e: 4, t: "one\ntwo\nthree" }], "manual cues keep every line");
  assert.equal(parseVtt("WEBVTT\n\n00:00.000 --> 00:01.000\n1 < 2 and 3 > 2 <3 <b>x</b>\n")[0].t, "1 < 2 and 3 > 2 <3 x", "only real tags are stripped");
  const t = (x) => parseVtt(`WEBVTT\n\n00:00.000 --> 00:01.000\n${x}\n`)[0]?.t;
  assert.equal(t("<<b>script>alert(1)</b>"), "<script>alert(1)", "a reassembled tag is not left to a single pass: the pieces are plain text");
  assert.equal(t("a <v Bob.loud>b</v> <ruby>x<rt>y</rt></ruby> <lang en>z</lang> <u>u</u> <00:01.5>w <00:00:01.500>v"), "a b xy z u w v");
  assert.equal(t("<script>x</script> <bad> <b"), "<script>x</script> <bad> <b", "unknown tags and an unclosed '<' stay as text");
  const long = parseVtt(`WEBVTT\n\n00:00.000 --> 00:01.000\n${"x".repeat(500)}\n`);
  assert.equal(long[0].t.length, 160);
  assert.deepEqual(parseVtt(""), []);
  assert.deepEqual(parseVtt("garbage <script>alert(1)</script>"), []);
});

// Shaped like a real YouTube automatic-caption download: word timing tags, 10 ms "echo" cues, align/position settings.
const YT_AUTO = `WEBVTT
Kind: captions
Language: en

00:00:00.480 --> 00:00:03.270 align:start position:0%
 
welcome<00:00:00.719><c> back</c><00:00:00.960><c> to</c><00:00:01.199><c> the</c><00:00:01.440><c> channel</c>

00:00:03.270 --> 00:00:03.280 align:start position:0%
welcome back to the channel
 

00:00:03.280 --> 00:00:05.510 align:start position:0%
welcome back to the channel
today<00:00:03.600><c> we</c><00:00:03.760><c> are</c><00:00:03.919><c> building</c>

00:00:05.510 --> 00:00:05.520 align:start position:0%
today we are building
 

00:00:05.520 --> 00:00:08.000 align:start position:0%
today we are building
a<00:00:05.680><c> small</c><00:00:06.000><c> thing</c>
`;
test("a real-shaped YouTube auto-caption file reads as one new line at a time", () => {
  const c = parseVtt(YT_AUTO, true);
  assert.deepEqual(c.map((x) => x.t), ["welcome back to the channel", "today we are building", "a small thing"]);
  assert.deepEqual(c.map((x) => Math.round(x.s * 1000) / 1000), [0.48, 3.28, 5.52]);
});

test("auto-caption rolling duplicates are dropped and only two lines kept; manual tracks keep repeated lines", () => {
  const vtt = "WEBVTT\n\n00:00.000 --> 00:02.000\nhello\nworld<00:00:01.000><c> again</c>\n\n00:02.000 --> 00:02.010\nworld again\n\n00:02.010 --> 00:04.000\nworld again\nnext line\n\n00:04.000 --> 00:05.000\nnext line\n\n00:05.000 --> 00:06.000\na\nb\nc\n";
  assert.deepEqual(parseVtt(vtt, true), [{ s: 0, e: 2, t: "hello\nworld again" }, { s: 2.01, e: 4, t: "next line" }, { s: 5, e: 6, t: "b\nc" }]);
  assert.equal(parseVtt(vtt, false).length, 5, "manual cues are shown as written");
});

test("activeAt: binary search at boundaries, gaps and overlaps", () => {
  const cues = [{ s: 1, e: 2, t: "a" }, { s: 3, e: 6, t: "b" }, { s: 4, e: 5, t: "c" }, { s: 10, e: 11, t: "d" }];
  const at = (t) => activeAt(cues, t);
  assert.equal(at(0.99), "");
  assert.equal(at(1), "a");
  assert.equal(at(1.99), "a");
  assert.equal(at(2), "", "end is exclusive");
  assert.equal(at(3.5), "b");
  assert.equal(at(4.5), "b\nc", "overlapping cues are both shown");
  assert.equal(at(5.5), "b");
  assert.equal(at(10.5), "d");
  assert.equal(at(99), "");
  assert.equal(activeAt([], 5), "");
  const many = Array.from({ length: 1000 }, (_, i) => ({ s: i * 2, e: i * 2 + 1, t: String(i) }));
  assert.equal(activeAt(many, 998.5), "499");
  assert.equal(activeAt(many, 999.5), "");
});

test("activeAt: a cue that outlives many later short ones is still found (running maximum end)", () => {
  const cues = [{ s: 0, e: 1000, t: "long" }, ...Array.from({ length: 50 }, (_, i) => ({ s: 10 + i, e: 10.5 + i, t: `s${i}` }))];
  assert.equal(activeAt(cues, 10.2), "long\ns0");
  assert.equal(activeAt(cues, 59.9), "long");
  assert.equal(activeAt(cues, 1000), "");
});

const TRACKS = [{ lang: "en", name: "English", auto: false }, { lang: "de", name: "German", auto: false }, { lang: "fr", name: "French", auto: true }];
const VTT = "WEBVTT\n\n00:00:05.000 --> 00:00:09.000\nhello\n\n00:05:02.000 --> 00:05:04.000\nafter seek\n";
const tick = () => new Promise((r) => setImmediate(r));
function setup({ tracks = TRACKS, vttOk = true, listOk = true } = {}) {
  for (const k of Object.keys(store)) delete store[k];
  docListeners.length = 0;
  const fetched = [];
  globalThis.fetch = async (u) => {
    fetched.push(u);
    if (u.includes("/subs?")) return { ok: listOk, status: listOk ? 200 : 502, json: async () => (listOk ? { tracks } : { error: "x" }) };
    return { ok: vttOk, status: vttOk ? 200 : 404, text: async () => VTT, json: async () => ({}) };
  };
  const root = el("div"); root.fs = el("button"); root.querySelector = (q) => (q === "video" ? video : root.fs);
  const video = el("video"); video.currentTime = 0;
  const player = { base: 0 };
  const now = () => player.base + video.currentTime;
  const out = { root, video, player, now, fetched, box: () => root.children.at(-1) };
  out.start = () => { subtitles(root, now, "AAAAAAAAAAA"); out.btn = root.fs.before_[0]; out.sel = root.fs.before_[1]; return tick(); };
  return out;
}

test("the CC button is there at once but nothing is fetched until captions are turned on", async () => {
  const s = setup();
  await s.start();
  assert.equal(s.btn.attrs["aria-pressed"], "false");
  assert.equal(s.btn.attrs["aria-label"], "Subtitles");
  assert.equal(s.sel.hidden, true);
  assert.deepEqual(s.fetched, [], "no track list, no VTT");
  s.btn.listeners.click[0]();
  await tick(); await tick();
  assert.deepEqual(s.fetched, ["/api/video/AAAAAAAAAAA/subs?pref=", "/api/video/AAAAAAAAAAA/subs/en.vtt"]);
  assert.equal(s.btn.attrs["aria-pressed"], "true");
  assert.equal(s.sel.hidden, false, "language menu appears with several tracks");
  assert.equal(store["yt.cc"], "1");
});

test("left on: the list is asked for with the saved language; an unknown saved language falls back to the first manual track", async () => {
  store["yt.cc"] = "1";
  const s = setup();
  store["yt.cc"] = "1"; store["yt.cc.lang"] = "fr";
  await s.start(); await tick(); await tick();
  assert.deepEqual(s.fetched, ["/api/video/AAAAAAAAAAA/subs?pref=fr", "/api/video/AAAAAAAAAAA/subs/fr.vtt"]);
  const s2 = setup();
  store["yt.cc"] = "1"; store["yt.cc.lang"] = "xx";
  await s2.start(); await tick(); await tick();
  assert.ok(s2.fetched.at(-1).endsWith("/subs/en.vtt"));
});

test("no tracks: a message, captions stay off, and the list is not asked for again", async (t) => {
  const s = setup({ tracks: [] });
  await s.start();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  s.btn.listeners.click[0](); await tick(); await tick();
  assert.equal(s.box().textContent, "No subtitles for this video");
  assert.equal(s.btn.attrs["aria-pressed"], "false");
  t.mock.timers.tick(3000);
  assert.equal(s.box().textContent, "");
  s.btn.listeners.click[0](); await tick(); await tick();
  assert.equal(s.fetched.length, 1, "asked once");
  assert.equal(s.box().textContent, "No subtitles for this video");
});

test("cues follow the ABSOLUTE time: after a seek restart the offset is added to currentTime", async () => {
  const s = setup();
  store["yt.cc"] = "1";
  await s.start(); await tick(); await tick();
  const upd = () => s.video.fire("timeupdate");
  s.video.currentTime = 6; upd();
  assert.equal(s.box().textContent, "hello");
  // the viewer seeks to 5:00: the stream restarts, base = 300 and currentTime starts again near 0
  s.player.base = 300; s.video.currentTime = 0.5; upd();
  assert.equal(s.box().textContent, "", "relative time 0.5 must not match anything");
  s.video.currentTime = 2.2; upd();
  assert.equal(s.box().textContent, "after seek");
  s.video.currentTime = 6; upd(); // 306: past the cue
  assert.equal(s.box().textContent, "");
  assert.equal(s.box().hidden, true);
});

test("toggle by button and by the c key; typing and modifiers are ignored; off clears the text", async () => {
  const s = setup();
  await s.start();
  key({ key: "c" });
  await tick(); await tick();
  assert.equal(s.btn.attrs["aria-pressed"], "true");
  s.video.currentTime = 6; s.video.fire("timeupdate");
  assert.equal(s.box().textContent, "hello");
  key({ key: "c", ctrlKey: true });
  key({ key: "c", metaKey: true });
  key({ key: "c", isComposing: true });
  key({ key: "c", target: { matches: () => true } });
  key({ key: "C" });
  assert.equal(s.btn.attrs["aria-pressed"], "true");
  key({ key: "c" });
  assert.equal(s.btn.attrs["aria-pressed"], "false");
  assert.equal(store["yt.cc"], "0");
  assert.equal(s.box().textContent, "");
});

test("choosing a language loads it and remembers it", async () => {
  const s = setup();
  await s.start();
  s.btn.listeners.click[0](); await tick(); await tick();
  s.sel.value = "de";
  s.sel.listeners.change[0](); await tick();
  assert.ok(s.fetched.at(-1).endsWith("/subs/de.vtt"));
  assert.equal(store["yt.cc.lang"], "de");
});

test("a failed download, a 404 and a failing track list each say so, do not save 'on' as shown, and clear themselves", async (t) => {
  for (const [opts, text] of [[{ vttOk: false }, "No subtitles in that language"], [{ listOk: false }, "Subtitles unavailable"]]) {
    const s = setup(opts);
    await s.start();
    t.mock.timers.enable({ apis: ["setTimeout"] });
    s.btn.listeners.click[0](); await tick(); await tick();
    assert.equal(s.box().textContent, text);
    assert.equal(s.btn.attrs["aria-pressed"], "false");
    t.mock.timers.tick(3000);
    assert.equal(s.box().textContent, "");
    t.mock.timers.reset();
  }
});

test("a failing list does not break the page, and the next toggle tries again", async (t) => {
  const s = setup({ listOk: false });
  await s.start();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  s.btn.listeners.click[0](); await tick(); await tick(); // fails, ends up off
  s.btn.listeners.click[0](); await tick(); await tick(); // tries again
  assert.equal(s.fetched.filter((u) => u.includes("/subs?")).length, 2, "a failed list is not remembered");
});
