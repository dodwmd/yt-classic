// Guardrails for the "no bloat JavaScript" rule: this is a small, same-origin, template-filling frontend.
// The point is to fail the build before it quietly grows into something heavy or unsafe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const PUBLIC = new URL("../public/", import.meta.url).pathname;
const read = (p) => readFileSync(join(PUBLIC, p), "utf8");
const jsFiles = readdirSync(join(PUBLIC, "js")).filter((f) => f.endsWith(".js"));
const htmlFiles = readdirSync(PUBLIC).filter((f) => f.endsWith(".html"));

// What a page actually downloads is its own module plus everything it imports, so the budget is per page: the
// gzipped size of each file in the page's import graph, summed. Raise it deliberately, in a reviewed change, if
// you really need to. (A total across all files would make every new page compete with every other page.)
const BUDGET_GZIP_BYTES = 8 * 1024;

function importGraph(entry, seen = new Set()) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  for (const m of read(`js/${entry}`).matchAll(/\bfrom\s+"\.\/([\w.-]+\.js)"/g)) importGraph(m[1], seen);
  return seen;
}
const gz = (f) => gzipSync(readFileSync(join(PUBLIC, "js", f))).length;

test("JavaScript per page stays within the size budget", () => {
  const entries = new Map(); // page -> entry module
  for (const f of htmlFiles) {
    const src = /<script\b[^>]*\bsrc="\/static\/js\/([\w.-]+\.js)"/i.exec(read(f))?.[1];
    if (src) entries.set(f, src);
  }
  assert.ok(entries.size >= 5, "expected several pages with scripts");
  for (const [page, entry] of entries) {
    const files = [...importGraph(entry)];
    const total = files.reduce((n, f) => n + gz(f), 0);
    console.log(`# JS ${page}: ${files.join(" + ")} = ${total} bytes gzipped (budget ${BUDGET_GZIP_BYTES})`);
    assert.ok(total <= BUDGET_GZIP_BYTES, `${page} ships ${total} bytes of JS gzipped, budget is ${BUDGET_GZIP_BYTES}`);
  }
  // Every script is reachable from some page (no orphaned code quietly accumulating).
  const reachable = new Set([...entries.values()].flatMap((e) => [...importGraph(e)]));
  for (const f of jsFiles) assert.ok(reachable.has(f), `${f} is not used by any page`);
});

test("no HTML-injection or dynamic-code sinks in the JS", () => {
  const forbidden = /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write|\beval\s*\(|new\s+Function\s*\(|setTimeout\(\s*["'`]|setInterval\(\s*["'`]|\.srcdoc\b|createContextualFragment|\.innerText\s*=/;
  for (const f of jsFiles) assert.doesNotMatch(read(`js/${f}`), forbidden, `${f} uses a forbidden sink`);
});

test("scripts are same-origin modules; no inline scripts, no third-party resources", () => {
  for (const f of htmlFiles) {
    const html = read(f);
    for (const m of html.matchAll(/<script\b([^>]*)>/gi)) {
      const src = /\bsrc="([^"]+)"/i.exec(m[1])?.[1];
      assert.ok(src, `${f}: inline <script> is not allowed`);
      assert.ok(src.startsWith("/static/js/") && existsSync(join(PUBLIC, src.replace("/static/", ""))), `${f}: bad script src ${src}`);
      assert.match(m[1], /type="module"/i, `${f}: scripts must be modules`);
    }
    assert.doesNotMatch(html, /<(link|script|iframe|img|video)[^>]+(?:src|href)="https?:\/\//i, `${f}: loads a remote resource`);
  }
});

test("JS never imports or fetches from another origin", () => {
  for (const f of jsFiles) {
    const js = read(`js/${f}`);
    assert.doesNotMatch(js, /\bimport\s*\(?\s*["'`]https?:/, `${f}: remote import`);
    assert.doesNotMatch(js, /\bfetch\(\s*["'`]https?:/, `${f}: absolute fetch`);
    // The only absolute URLs allowed are YouTube's thumbnail host and the https:// check in safeImg.
    for (const u of js.matchAll(/https?:\/\/[^\s"'`)]*/g)) {
      assert.ok(u[0] === "https://" || u[0].startsWith("https://i.ytimg.com/vi/"), `${f}: unexpected URL ${u[0]}`);
    }
  }
});

test("every template and element a page script looks up exists in its HTML", () => {
  const pairs = { "home.js": "index.html", "results.js": "results.html", "watch.js": "watch.html", "channel.js": "channel.html", "history.js": "history.html", "playlists.js": "playlists.html", "subscriptions.js": "subscriptions.html" };
  const allHtml = htmlFiles.map(read).join("\n");
  for (const [script, page] of Object.entries(pairs)) {
    const js = read(`js/${script}`) + read("js/lib.js");
    const html = read(page);
    for (const m of read(`js/${script}`).matchAll(/\$\("#([\w-]+)"\)/g)) {
      assert.match(html, new RegExp(`id="${m[1]}"`), `${script}: #${m[1]} is not in ${page}`);
    }
    for (const m of js.matchAll(/clone\("([\w-]+)"\)/g)) {
      assert.match(allHtml, new RegExp(`<template id="${m[1]}"`), `${script}: template ${m[1]} not found`);
    }
    for (const m of read(`js/${script}`).matchAll(/\$\("\.([\w-]+)",/g)) {
      assert.match(allHtml, new RegExp(`class="[^"]*\\b${m[1]}\\b`), `${script}: .${m[1]} is not in any template`);
    }
  }
});

// Mobile rules must never leak into the desktop layout, and zooming must stay possible.
test("every rule after the 'Small screens' marker in classic.css is inside an @media block", () => {
  const css = read("classic.css");
  const at = css.indexOf("Small screens");
  assert.ok(at > 0, "marker comment 'Small screens' is missing");
  const rest = css.slice(css.lastIndexOf("/*", at)).replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0, top = "";
  for (const ch of rest) {
    if (ch === "{") { if (depth === 0) assert.match(top.trim(), /^@media\b/, `rule outside @media: ${top.trim()}`); depth++; top = ""; }
    else if (ch === "}") { depth--; assert.ok(depth >= 0, "unbalanced braces"); top = ""; }
    else if (depth === 0) top += ch;
  }
  assert.equal(depth, 0, "unbalanced braces");
  assert.equal(top.trim(), "", "stray text at top level");
});

test("viewport meta allows zooming on every page", () => {
  for (const f of htmlFiles) {
    const m = read(f).match(/<meta name="viewport" content="([^"]*)"/);
    assert.ok(m, `${f} has no viewport meta`);
    assert.doesNotMatch(m[1], /user-scalable|maximum-scale/i, `${f} blocks zoom`);
  }
});

// nginx's default body limit is 8k for every route; only the subscription import may take a whole file.
test("nginx: only the exact import location raises client_max_body_size, and the server default stays 8k", () => {
  const conf = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8").replace(/#.*$/gm, "");
  const re = /client_max_body_size\s+(\S+);/g;
  const found = [];
  for (const m of conf.matchAll(re)) {
    // the innermost enclosing `location ... {` (or the server block) of this directive
    const before = conf.slice(0, m.index);
    const open = [...before.matchAll(/([^{};]*)\{|\}/g)];
    const stack = [];
    for (const t of open) {
      if (t[0] === "}") stack.pop();
      else stack.push(t[1].trim());
    }
    found.push([stack.at(-1), m[1]]);
  }
  assert.deepEqual(found.sort(), [["location = /api/subscriptions/import", "1m"], ["server", "8k"]]);
  assert.match(conf, /location = \/api\/subscriptions\/import \{[^}]*limit_conn[^}]*limit_req/s, "the import location must be rate limited");
});

test("compose.yaml bounds the frontend's /tmp tmpfs", () => {
  const compose = readFileSync(new URL("../../compose.yaml", import.meta.url), "utf8");
  assert.match(compose.slice(compose.indexOf("  frontend:")), /tmpfs: \["\/tmp:size=\d+m"\]/);
});

test("login page: nginx route exists, the form posts to the backend (which validates next), 401 redirects to it", () => {
  const nginx = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8");
  assert.match(nginx, /location = \/login\s+\{[^}]*try_files \/login\.html/);
  assert.match(read("js/lib.js"), /\/api\/login\?next=/);
  assert.match(read("login.html"), /<form id="login" method="post" action="\/api\/login"[^>]*>[\s\S]*type="password"/);
  assert.match(read("classic.css"), /#login \.msg:target/);
  const lib = read("js/lib.js");
  assert.match(lib, /res\.status === 401[\s\S]*\/login\?next=/);
  for (const f of htmlFiles.filter((x) => x !== "login.html")) {
    assert.match(read(f), /<footer id="foot" hidden><form method="post" action="\/api\/logout">/, `${f} needs the Log out footer`);
  }
});

test("undecorated(): later pages only decorate their new cards", async () => {
  globalThis.document = { getElementById: () => null };
  const { undecorated } = await import("../public/js/lib.js");
  const a = { dataset: {} }, b = { dataset: {} };
  assert.deepEqual(undecorated([a, b]), [a, b]);
  a.dataset.d = 1; // what markWatched sets once a thumb has its badge and toggle
  assert.deepEqual(undecorated([a, b]), [b]);
  b.dataset.d = 1;
  assert.deepEqual(undecorated([a, b]), []);
});

test("markWatched decorates each thumb once, and only when the membership is known", async () => {
  globalThis.document = { getElementById: () => null, querySelectorAll: () => thumbs, createElement: () => ({ setAttribute() {}, addEventListener() {}, append() {}, dataset: {} }) };
  const mk = (id) => ({ dataset: {}, search: `?v=${id}`, append() { this.appended = (this.appended ?? 0) + 1; }, parentElement: { append() { this.n = (this.n ?? 0) + 1; }, querySelector: () => null } });
  const thumbs = [mk("AAAAAAAAAA1"), mk("AAAAAAAAAA2")];
  let fail = true;
  const urls = [];
  globalThis.fetch = async (u) => {
    urls.push(u);
    if (String(u).includes("membership") && fail) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (String(u).includes("membership") ? { watchLater: ["AAAAAAAAAA1"] } : { ids: ["AAAAAAAAAA2"] }) };
  };
  const { markWatched } = await import("../public/js/lib.js");
  await markWatched();
  assert.ok(thumbs.every((t) => !t.dataset.d && !t.parentElement.n), "a failed membership lookup shows no toggle at all");
  fail = false;
  await markWatched();
  assert.ok(thumbs.every((t) => t.dataset.d && t.parentElement.n === 1));
  const calls = urls.length;
  await markWatched(); // e.g. "Load more" with nothing new
  assert.equal(urls.length, calls, "decorated thumbs are not asked about again");
  assert.ok(thumbs.every((t) => t.parentElement.n === 1), "no duplicate toggles");
  assert.equal(thumbs[1].appended, 1, "no duplicate Watched badge");
});

test("destination() only ever returns one of the known pages, rebuilt from constants and validated ids", async () => {
  globalThis.document = { getElementById: () => null }; // lib.js looks up the login form when it loads
  const { destination } = await import("../public/js/lib.js");
  const ID = "dQw4w9WgXcQ", UC = "UC" + "a".repeat(22);
  const hostile = ["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "/%09/evil.com", "/%0a/evil.com", "javascript:alert(1)", "https://evil.com", "http://evil.com/watch?v=" + ID,
    "evil.com", "", null, undefined, "x", "/history/../../evil", "/history?x=1", "/watch?v=short", "/watch?v=" + ID.slice(1) + "<", "/watch", "/watch?v=%3Cscript%3E123",
    "/channel/UC123", "/channel/" + UC + "x", "/channel/" + UC + "/..", "/channel//evil.com", "/results?search_query=" + "a".repeat(201), "/results?search_query=<script>", "/results?search_query=a b", "/results?search_query=a\\b",
    "/results?search_query=a#//evil.com", "/ ", " /history", "/HISTORY"];
  for (const h of hostile) assert.equal(destination(h), "/", `${JSON.stringify(h)} must fall back to /`);
  assert.equal(destination("/"), "/");
  assert.equal(destination("/history"), "/history");
  assert.equal(destination("/subscriptions"), "/subscriptions");
  assert.equal(destination("/playlists"), "/playlists");
  assert.equal(destination("/playlists?id=12"), "/playlists?id=12");
  for (const bad of ["/playlists?id=", "/playlists?id=1x", "/playlists?id=1&x=//evil.com", "/playlists?id=1234567890", "/playlists/"]) assert.equal(destination(bad), "/", bad);
  assert.equal(destination("/constructor"), "/");
  assert.equal(destination("__proto__"), "/");
  assert.equal(destination(`/watch?v=${ID}`), `/watch?v=${ID}`);
  assert.equal(destination(`/watch?v=${ID}&t=5&q=720`), `/watch?v=${ID}`, "extra parameters are dropped, not copied");
  assert.equal(destination(`/channel/${UC}`), `/channel/${UC}`);
  assert.equal(destination("/results?search_query=nix+os"), "/", "search pages fall back to the home page");
  // Through the real query-string decoding that the login page uses (%09 turns into a TAB there).
  for (const evil of ["/%09/evil.com", "/%0a/evil.com", "//evil.com", "/%5cevil.com"]) assert.equal(destination(new URLSearchParams(`next=${evil}`).get("next")), "/", evil);
  const out = destination(`/watch?v=${ID}&x=//evil.com`);
  assert.ok(!out.includes("evil"));
});
