import { test } from "node:test";
import assert from "node:assert/strict";

// A tiny fake DOM: elements keep what is set on them; the comment template is a tree of elements found by class.
class El {
  constructor(cls = "", kids = []) { this.cls = cls; this.children = kids; this.attrs = {}; this.dataset = {}; this.hidden = false; this.textContent = ""; }
  append(...n) { this.children.push(...n); }
  replaceChildren() { this.children = []; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k] ?? null; }
  querySelector(sel) {
    const want = sel.slice(1);
    for (const c of this.children) { if (c.cls === want) return c; const r = c.querySelector(sel); if (r) return r; }
    return null;
  }
  cloneNode() { const e = new El(this.cls, this.children.map((c) => c.cloneNode())); e.hidden = this.hidden; e.dataset = { ...this.dataset }; return e; }
}
const tmpl = () => new El("cm", [new El("av"), new El("cb", [new El("ch", [new El("au"), new El("ag")]), new El("ct"), new El("cf", [new El("lk"), Object.assign(new El("rp"), { hidden: true })]),
  Object.assign(new El("rl", [new El("rb"), new El("rs"), Object.assign(new El("rm"), { dataset: { label: "Show more replies" } })]), { hidden: true })])]);
const ids = new Map();
const byId = (id, el) => (ids.set(id, el), el);
const order = [Object.assign(new El(), { dataset: { o: "top" }, attrs: { "aria-pressed": "true" } }), Object.assign(new El(), { dataset: { o: "new" }, attrs: { "aria-pressed": "false" } })];
globalThis.document = {
  getElementById: (id) => (id === "t-comment" ? { content: { firstElementChild: tmpl() } } : null),
  querySelector: (sel) => ids.get(sel.slice(1)) ?? null,
  querySelectorAll: () => order,
};
const UC = "UC" + "a".repeat(22);
const T = "Ug" + "x".repeat(24);
const urls = [];
let pages;
globalThis.fetch = async (u) => {
  urls.push(String(u));
  const r = pages.shift();
  return { ok: r.status === undefined, status: r.status ?? 200, json: async () => r.body };
};
// The module keeps per-page state (one video per page), so every test loads its own copy.
let copies = 0;
const load = async () => (await import(`../public/js/comments.js?copy=${copies++}`)).toggleComments;

const c = (id, over = {}) => ({ id, author: "Al<b>", authorChannelId: UC, authorThumb: "https://yt3.ggpht.com/a", text: "<img src=x onerror=alert(1)> https://x.example", likeCount: 1234, publishedAt: new Date().toISOString(), replyCount: 0, ...over });
const setup = () => {
  ids.clear(); urls.length = 0;
  const btn = byId("cm-open", Object.assign(new El(), { textContent: "Show comments (5)" }));
  byId("cm-body", Object.assign(new El(), { hidden: true }));
  byId("cm-list", new El());
  byId("cm-msg", new El());
  byId("cm-more", Object.assign(new El(), { hidden: true, dataset: { label: "Load more" } }));
  return btn;
};
const tick = () => new Promise((r) => setImmediate(r));

test("nothing is requested until the section is opened; the first opening loads the first page as plain text", async () => {
  const btn = setup(), toggleComments = await load();
  pages = [{ body: { items: [c(T, { replyCount: 3 }), c("Ug" + "y".repeat(24))], nextPageToken: "N1" } }];
  assert.equal(urls.length, 0);
  toggleComments("dQw4w9WgXcQ", btn);
  await tick(); await tick();
  assert.deepEqual(urls, ["/api/video/dQw4w9WgXcQ/comments?order=top"]);
  assert.equal(ids.get("cm-body").hidden, false);
  assert.equal(btn.textContent, "Hide comments (5)");
  assert.equal(btn.attrs["aria-expanded"], "true");
  const list = ids.get("cm-list").children;
  assert.equal(list.length, 2);
  const first = list[0];
  assert.equal(first.querySelector(".ct").textContent, "<img src=x onerror=alert(1)> https://x.example", "text stays text");
  assert.equal(first.querySelector(".au").href, `/channel/${UC}`);
  assert.equal(first.querySelector(".lk").textContent, "1,234 likes");
  assert.equal(first.querySelector(".rp").hidden, false);
  assert.equal(first.querySelector(".rp").textContent, "Show 3 replies");
  assert.equal(list[1].querySelector(".rp").hidden, true);
  assert.equal(ids.get("cm-more").hidden, false);
  // closing and reopening does not fetch again
  toggleComments("dQw4w9WgXcQ", btn);
  assert.equal(ids.get("cm-body").hidden, true);
  assert.equal(btn.textContent, "Show comments (5)");
  toggleComments("dQw4w9WgXcQ", btn);
  await tick();
  assert.equal(urls.length, 1);
});

test("Load more uses the page token and a second click while loading is ignored; replies load lazily", async () => {
  const btn = setup(), toggleComments = await load();
  pages = [{ body: { items: [c(T, { replyCount: 1 })], nextPageToken: "N1" } }];
  toggleComments("dQw4w9WgXcQ", btn);
  await tick(); await tick();
  const more = ids.get("cm-more");
  pages = [{ body: { items: [c("Ug" + "z".repeat(24))] } }];
  more.onclick(); more.onclick();
  await tick(); await tick();
  assert.equal(urls.length, 2, "one request for two clicks");
  assert.equal(urls[1], "/api/video/dQw4w9WgXcQ/comments?order=top&pageToken=N1");
  assert.equal(more.hidden, true, "no token left");
  assert.equal(ids.get("cm-list").children.length, 2);
  // replies
  const first = ids.get("cm-list").children[0];
  pages = [{ body: { items: [c(T + ".r1", { text: "a reply" })] } }];
  first.querySelector(".rp").onclick();
  await tick(); await tick();
  assert.equal(urls[2], `/api/comments/${T}/replies?`);
  assert.equal(first.querySelector(".rl").hidden, false);
  assert.equal(first.querySelector(".rb").children[0].querySelector(".ct").textContent, "a reply");
  assert.equal(first.querySelector(".rs").textContent, "", "the reply status is cleared on the thread's own line, not a reply's");
  first.querySelector(".rp").onclick(); // hide
  first.querySelector(".rp").onclick(); // show again: no new request
  await tick();
  assert.equal(urls.length, 3);
});

test("switching to Newest starts over; a slow answer for the old order is dropped", async () => {
  const btn = setup(), toggleComments = await load();
  let release;
  globalThis.fetch = async (u) => { urls.push(String(u)); if (urls.length === 1) await new Promise((r) => (release = r)); const r = pages.shift(); return { ok: true, status: 200, json: async () => r.body }; };
  pages = [{ body: { items: [c("Ug" + "o".repeat(24))] } }, { body: { items: [c("Ug" + "n".repeat(24))] } }];
  toggleComments("dQw4w9WgXcQ", btn);
  await tick();
  order[1].onclick();
  await tick(); await tick();
  assert.equal(urls[1], "/api/video/dQw4w9WgXcQ/comments?order=new");
  assert.equal(order[1].attrs["aria-pressed"], "true");
  assert.equal(order[0].attrs["aria-pressed"], "false");
  release();
  await tick(); await tick();
  assert.equal(ids.get("cm-list").children.length, 1, "only the Newest page is shown");
});

test("disabled comments and errors are said in words; an error offers a retry", async () => {
  let btn = setup();
  const toggleComments = await load();
  globalThis.fetch = async (u) => { urls.push(String(u)); const r = pages.shift(); return { ok: false, status: r.status, json: async () => r.body }; };
  pages = [{ status: 403, body: { error: "Comments are turned off for this video.", code: "comments-disabled", retryable: false } }];
  toggleComments("dQw4w9WgXcQ", btn);
  await tick(); await tick();
  assert.equal(ids.get("cm-msg").textContent, "Comments are turned off for this video.");
  assert.equal(ids.get("cm-more").hidden, true);
  // fresh page: a retryable error
  const fresh = await load();
  btn = setup();
  pages = [{ status: 502, body: { error: "Couldn't reach YouTube.", code: "network", retryable: true } }, { status: 200, body: { items: [c(T)] } }];
  fresh("dQw4w9WgXcQ", btn);
  await tick(); await tick();
  assert.match(ids.get("cm-msg").textContent, /Couldn't reach YouTube\. You can try again\./);
  assert.equal(ids.get("cm-more").textContent, "Try again");
  assert.equal(ids.get("cm-more").hidden, false);
});

test("thread cap, per-list empty text, and switching order clears the old order's controls", async () => {
  const btn = setup(), toggle = await load();
  globalThis.fetch = async (u) => {
    urls.push(String(u));
    if (String(u).includes("/replies")) return { ok: true, status: 200, json: async () => ({ items: [] }) };
    return { ok: true, status: 200, json: async () => ({ items: Array.from({ length: 120 }, (_, i) => c("Ug" + String(urls.length * 1000 + i).padStart(24, "0"), { replyCount: i === 0 ? 2 : 0 })), nextPageToken: "N" }) };
  };
  toggle("dQw4w9WgXcQ", btn);
  await tick(); await tick();
  const more = ids.get("cm-more");
  assert.equal(more.hidden, false);
  more.onclick();
  await tick(); await tick();
  assert.equal(ids.get("cm-list").children.length, 240, "a page is never cut: the cap stops further pages");
  assert.equal(more.hidden, true, "no Load more past the cap");
  assert.match(ids.get("cm-msg").textContent, /first 200/);
  // an empty replies list says so in its own words
  const first = ids.get("cm-list").children[0];
  first.querySelector(".rp").onclick();
  await tick(); await tick();
  assert.equal(first.querySelector(".rs").textContent, "No replies.");
  // switching order starts clean
  order[1].onclick();
  assert.equal(more.hidden, true);
  assert.equal(ids.get("cm-list").children.length, 0);
});

test("watch.js: a comments module that fails to load says so and leaves the button usable", async () => {
  const { mkdtempSync, mkdirSync, copyFileSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "yt-watch-"));
  mkdirSync(join(dir, "js"));
  writeFileSync(join(dir, "package.json"), '{"type":"module"}');
  const src = new URL("../public/js/", import.meta.url);
  for (const f of ["watch.js", "lib.js", "fmt.js", "player.js"]) copyFileSync(new URL(f, src), join(dir, "js", f)); // no comments.js: the import rejects
  const store = new Map();
  const el = () => new Proxy({ children: [], attrs: {}, dataset: {} }, {
    get: (t, k) => (k in t ? t[k] : k === "append" || k === "prepend" ? (...n) => t.children.push(...n) : k === "setAttribute" ? (a, v) => (t.attrs[a] = v) : k === "querySelector" ? () => el() : k === "addEventListener" ? () => {} : undefined),
    set: (t, k, v) => ((t[k] = v), true),
  });
  const real = { document: globalThis.document, fetch: globalThis.fetch, location: globalThis.location, setInterval: globalThis.setInterval };
  globalThis.setInterval = () => 0; // the player's progress reporter must not keep the test process alive
  const get = (sel) => (store.has(sel) ? store.get(sel) : store.set(sel, Object.assign(el(), { textContent: "" })).get(sel));
  globalThis.document = { getElementById: () => null, addEventListener() {}, querySelector: get, querySelectorAll: () => [], createElement: () => el(), title: "" };
  globalThis.location = { pathname: "/watch", search: "?v=dQw4w9WgXcQ" };
  globalThis.addEventListener = () => {};
  globalThis.fetch = async (u) => ({ ok: true, status: 200, json: async () => (String(u).startsWith("/api/video/") ? { video: { id: "dQw4w9WgXcQ", title: "T", commentCount: "5", durationSeconds: 60 }, related: { items: [] }, quality: 720, qualities: [720], lang: "" } : {}) });
  try {
    await import(new URL(`file://${join(dir, "js", "watch.js")}`).href);
    await new Promise((r) => setTimeout(r, 30));
    const btn = get("#cm-open");
    assert.equal(btn.textContent, " (5)", "the count is appended to the button text (the fake button starts empty)");
    assert.equal(typeof btn.onclick, "function");
    await btn.onclick();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(get("#cm-fail").textContent, "Couldn't load comments. Try again.");
    assert.equal(typeof btn.onclick, "function", "the button still works");
  } finally {
    Object.assign(globalThis, real);
  }
});
