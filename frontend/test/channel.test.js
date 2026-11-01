import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// A tiny fake DOM: every selector gives one element that remembers what was set on it. No templates are needed because
// the fake API answers with empty lists; what is checked is which requests the page makes and the links it builds.
const els = new Map();
const el = () => new Proxy({ children: [], attrs: {} }, {
  get: (t, k) => {
    if (k in t) return t[k];
    if (k === "append" || k === "prepend") return (...n) => t.children.push(...n);
    if (k === "setAttribute") return (a, v) => (t.attrs[a] = v);
    if (k === "querySelector") return () => el();
    if (k === "addEventListener") return () => {};
    return undefined;
  },
});
globalThis.document = {
  getElementById: () => null,
  querySelector: (sel) => (els.has(sel) ? els.get(sel) : els.set(sel, el()).get(sel)),
  querySelectorAll: () => [],
  createElement: () => el(),
  title: "",
};

const UC = "UC" + "a".repeat(22);
const PL = "PL" + "b".repeat(16);
let urls, fail;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.startsWith("/api/channel/")) urls.push(u);
  const bad = fail && u.startsWith("/api/channel/") && fail.test(u);
  if (bad) return { status: 500, ok: false, json: async () => ({ error: "boom " + u }) };
  const channel = { id: UC, title: "Chan", thumb: "" };
  return {
    status: 200, ok: true,
    json: async () => ({ channel, subscribed: false, page: { items: [], nextPageToken: "NEXT_1" }, playlist: { title: "Mix" }, about: { description: "d", links: [], subscriberCount: "5" } }),
  };
};

const counter = { n: 0 };
async function visit(search) {
  els.clear();
  urls = [];
  globalThis.location = { pathname: `/channel/${UC}`, search };
  await import(`../public/js/channel.js?run=${counter.n++}`);
  await new Promise((r) => setTimeout(r, 20));
  return urls.slice();
}
const base = `/api/channel/${UC}`;

test("every tab requests the right URLs, with and without a list or page token", async () => {
  const cases = [
    ["", [base]],
    ["?pageToken=abc_-1", [`${base}?pageToken=abc_-1`]], // the Videos tab must pass its token on (Older/Newer paging)
    ["?tab=videos&pageToken=T9", [`${base}?pageToken=T9`]],
    ["?tab=playlists", [`${base}/head`, `${base}/playlists`]],
    ["?tab=playlists&pageToken=T2", [`${base}/head`, `${base}/playlists?pageToken=T2`]],
    [`?tab=playlists&list=${PL}`, [`${base}/head`, `${base}/playlist/${PL}`]],
    [`?tab=playlists&list=${PL}&pageToken=I2`, [`${base}/head`, `${base}/playlist/${PL}?pageToken=I2`]],
    ["?tab=shorts", [`${base}/head`, `${base}/shorts`]],
    ["?tab=shorts&pageToken=50", [`${base}/head`, `${base}/shorts?pageToken=50`]],
    ["?tab=live&pageToken=S1", [`${base}/head`, `${base}/live?pageToken=S1`]],
    ["?tab=about", [`${base}/head`, `${base}/about`]],
    // Anything outside the allowlists is ignored, never sent.
    ["?tab=nope", [base]],
    ["?tab=shorts&list=" + PL, [`${base}/head`, `${base}/shorts`]],
    ["?tab=playlists&list=../x", [`${base}/head`, `${base}/playlists`]],
    ["?pageToken=a.b", [base]],
    ["?pageToken=" + "x".repeat(121), [base]],
  ];
  for (const [search, expected] of cases) assert.deepEqual(await visit(search), expected, search);
});

test("non-video tabs never fetch the uploads page", async () => {
  for (const tab of ["playlists", "shorts", "live", "about"]) {
    const got = await visit(`?tab=${tab}`);
    assert.ok(!got.includes(base) && got.includes(`${base}/head`), tab);
  }
});

test("Older links keep the tab, the list and the token", async () => {
  await visit("?pageToken=T1");
  assert.equal(els.get("#next").href, `/channel/${UC}?pageToken=NEXT_1`);
  await visit(`?tab=playlists&list=${PL}`);
  assert.equal(els.get("#next").href, `/channel/${UC}?tab=playlists&list=${PL}&pageToken=NEXT_1`);
});

test("when both requests fail nothing is left unhandled and the error is shown", async () => {
  const unhandled = [];
  const on = (e) => unhandled.push(e);
  process.on("unhandledRejection", on);
  fail = /./;
  try {
    const got = await visit("?tab=shorts");
    await new Promise((r) => setImmediate(r));
    assert.equal(got.length, 2, "both were started");
    assert.deepEqual(unhandled, []);
    assert.match(els.get("#status").textContent, /boom/);
  } finally {
    process.off("unhandledRejection", on);
    fail = null;
  }
});

test("the playlist and page token patterns are the backend's", () => {
  const be = readFileSync(new URL("../../backend/src/yt/api.ts", import.meta.url), "utf8");
  const fe = readFileSync(new URL("../public/js/lib.js", import.meta.url), "utf8");
  assert.equal(/LIST_ID = (\/.*?\/), TOKEN/.exec(fe)?.[1], /YT_PLAYLIST_ID = (\/.*\/);/.exec(be)?.[1]);
  assert.equal(/TOKEN = (\/.*?\/);/.exec(fe)?.[1], /PAGE_TOKEN = (\/.*\/);/.exec(be)?.[1]);
});
