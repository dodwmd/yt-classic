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

// Quotes may be ', " or `; a lazy module's own static imports count too (importGraph recurses).
export const STATIC_IMPORT = /\bfrom\s*["'`]\.\/([\w.-]+\.js)["'`]/g;
export const LAZY_IMPORT = /\bimport\(\s*["'`]\.\/([\w.-]+\.js)["'`]\s*\)/g;
export const ANY_DYNAMIC_IMPORT = /\bimport\s*\(/g;

function importGraph(entry, seen = new Set(), lazy = false) {
  if (seen.has(entry)) return seen;
  seen.add(entry);
  const src = read(`js/${entry}`);
  for (const m of src.matchAll(STATIC_IMPORT)) importGraph(m[1], seen, lazy);
  // import("./x.js") loads on demand, after the page works: not part of its initial budget, but it must exist and stay small.
  if (lazy) for (const m of src.matchAll(LAZY_IMPORT)) importGraph(m[1], seen, lazy);
  return seen;
}
const LAZY_MODULE_GZIP_BYTES = 3 * 1024; // each on-demand module (it loads after the page works)
// Every on-demand module has its OWN explicit cap (its current gzipped size plus about 15% headroom); a page's on-demand total is
// therefore the sum of the caps of the modules it can load, and a new lazy module must add a line here, in a reviewed change.
// (This replaced a per-page total allowance that every new module quietly bumped.)
export const LAZY_CAPS = {
  "dest.js": 920,
  "suggest.js": 800,
  "speed.js": 2650,
  "comments.js": 2000,
  "quality.js": 2050,
  "chapters.js": 2250,
  "subs.js": 3050,
};
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
  const reachable = new Set([...entries.values()].flatMap((e) => [...importGraph(e, new Set(), true)]));
  for (const e of new Set(entries.values())) {
    const lazyOnly = [...importGraph(e, new Set(), true)].filter((f) => !importGraph(e).has(f));
    const total = lazyOnly.reduce((n, f) => n + gz(f), 0);
    if (lazyOnly.length) console.log(`# JS ${e} loads on demand: ${lazyOnly.join(" + ")} = ${total} bytes gzipped`);
    for (const f of lazyOnly) {
      assert.ok(f in LAZY_CAPS, `${f} is a lazy module without a cap in LAZY_CAPS`);
      assert.ok(gz(f) <= LAZY_CAPS[f] && LAZY_CAPS[f] <= LAZY_MODULE_GZIP_BYTES, `${f} is ${gz(f)} bytes gzipped, its cap is ${LAZY_CAPS[f]}`);
    }
  }
  for (const f of jsFiles) assert.ok(reachable.has(f), `${f} is not used by any page`);
});

// Comments are opt-in: their code is fetched with a dynamic import() on first open, so it must stay out of every page's
// static graph (the budget above) and stay small.
test("the comments module is lazy: never statically imported, under 3 KB gzipped", () => {
  const LAZY_MAX = 2.5 * 1024;
  assert.match(read("js/watch.js"), /import\("\.\/comments\.js"\)/);
  for (const f of jsFiles) assert.doesNotMatch(read(`js/${f}`), /\bfrom\s+"\.\/comments\.js"/, `${f} imports comments.js statically`);
  const size = gz("comments.js");
  console.log(`# JS comments.js (lazy) = ${size} bytes gzipped (max ${LAZY_MAX})`);
  assert.ok(size < LAZY_MAX, `comments.js is ${size} bytes gzipped`);
});

test("the subtitles module is lazy: only watch.js imports it, with a catch (its size is capped in LAZY_CAPS)", () => {
  assert.match(read("js/watch.js"), /import\("\.\/subs\.js"\)[^;]*\.catch\(/);
  for (const f of jsFiles) assert.doesNotMatch(read(`js/${f}`), /\bfrom\s+"\.\/subs\.js"/, `${f} imports subs.js statically`);
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
  const pairs = { "home.js": "index.html", "results.js": "results.html", "watch.js": "watch.html", "comments.js": "watch.html", "chapters.js": "watch.html", "channel.js": "channel.html", "history.js": "history.html", "playlists.js": "playlists.html", "subscriptions.js": "subscriptions.html", "tv.js": "tv.html" };
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
  const { destination } = await import("../public/js/dest.js");
  const ID = "dQw4w9WgXcQ", UC = "UC" + "a".repeat(22);
  const hostile = ["//evil.com", "/\\evil.com", "/\t/evil.com", "/\n/evil.com", "/%09/evil.com", "/%0a/evil.com", "javascript:alert(1)", "https://evil.com", "http://evil.com/watch?v=" + ID,
    "evil.com", "", null, undefined, "x", "/history/../../evil", "/history?x=1", "/watch?v=short", "/watch?v=" + ID.slice(1) + "<", "/watch", "/watch?v=%3Cscript%3E123",
    "/channel/UC123", "/channel/" + UC + "x", "/channel/" + UC + "/..", "/channel//evil.com", "/results?search_query=" + "a".repeat(201), "/results?search_query=<script>", "/results?search_query=a b", "/results?search_query=a\\b",
    "/results?search_query=a#//evil.com", "/ ", " /history", "/HISTORY"];
  for (const h of hostile) assert.equal(destination(h), "/", `${JSON.stringify(h)} must fall back to /`);
  assert.equal(destination("/"), "/");
  assert.equal(destination("/history"), "/history");
  assert.equal(destination("/subscriptions"), "/subscriptions");
  assert.equal(destination("/tv"), "/tv");
  for (const bad of ["/tv?x=1", "/tv/", "/TV", "/tv#//evil.com"]) assert.equal(destination(bad), "/", bad);
  assert.equal(destination("/playlists"), "/playlists");
  assert.equal(destination("/playlists?id=12"), "/playlists?id=12");
  for (const bad of ["/playlists?id=", "/playlists?id=1x", "/playlists?id=1&x=//evil.com", "/playlists?id=1234567890", "/playlists/"]) assert.equal(destination(bad), "/", bad);
  assert.equal(destination("/constructor"), "/");
  assert.equal(destination("__proto__"), "/");
  assert.equal(destination(`/watch?v=${ID}`), `/watch?v=${ID}`);
  assert.equal(destination(`/watch?v=${ID}&t=5&q=720`), `/watch?v=${ID}`, "extra parameters are dropped, not copied");
  assert.equal(destination(`/channel/${UC}`), `/channel/${UC}`);
  // A login bounce from a channel tab comes back to that tab: the query is rebuilt from the allowlists, never copied.
  const PL = "PL" + "b".repeat(16);
  assert.equal(destination(`/channel/${UC}?tab=shorts`), `/channel/${UC}?tab=shorts`);
  assert.equal(destination(`/channel/${UC}?tab=playlists&list=${PL}&pageToken=I2`), `/channel/${UC}?tab=playlists&list=${PL}&pageToken=I2`);
  assert.equal(destination(`/channel/${UC}?pageToken=abc`), `/channel/${UC}?pageToken=abc`);
  assert.equal(destination(`/channel/${UC}?tab=about&x=//evil.com&pageToken=a.b`), `/channel/${UC}?tab=about`, "unknown and invalid parts are dropped");
  assert.equal(destination(`/channel/${UC}?tab=shorts&list=${PL}`), `/channel/${UC}?tab=shorts`);
  assert.equal(destination(`/channel/${UC}?tab=evil`), `/channel/${UC}`);
  assert.equal(destination(`/channel/${UC}?`), `/channel/${UC}`);
  for (const bad of [`/channel/${UC}?tab=shorts#//evil.com`, `/channel/${UC}/?tab=shorts`, `/channel/${UC}x?tab=shorts`]) assert.equal(destination(bad), "/", bad);
  const good = { "/results?search_query=nix+os": "/results?search_query=nix+os", "/results?search_query=nix%20os": "/results?search_query=nix%20os", "/results?search_query=%C3%A9t%C3%A9": "/results?search_query=%C3%A9t%C3%A9",
    "/results?search_query=cats&type=channel": "/results?search_query=cats&type=channel", "/results?search_query=cats&type=video&duration=short&sort=views": "/results?search_query=cats&type=video&duration=short&sort=views" };
  for (const [from, to] of Object.entries(good)) assert.equal(destination(from), to, from);
  const badResults = ["/results", "/results?", "/results?search_query=", "/results?search_query=%20", "/results?search_query=a&type=playlist", "/results?search_query=a&type=video&type=channel", "/results?search_query=a&evil=1",
    "/results?search_query=a&type=channel&x=//evil.com", "/results?search_query=a%0Ab", "/results?search_query=a%00", "/results?search_query=%E0%A4%A", "/results?search_query=a&sort=__proto__", "/results?x=1&search_query=a", "//results?search_query=a",
    "/results?search_query=a&pageToken=2", "/results?search_query=a&duration=any&sort=date&type=channel&duration=short"];
  for (const bad of badResults) assert.equal(destination(bad), "/", bad);
  // Through the real query-string decoding that the login page uses (%09 turns into a TAB there).
  for (const evil of ["/%09/evil.com", "/%0a/evil.com", "//evil.com", "/%5cevil.com"]) assert.equal(destination(new URLSearchParams(`next=${evil}`).get("next")), "/", evil);
  const out = destination(`/watch?v=${ID}&x=//evil.com`);
  assert.ok(!out.includes("evil"));
});

test("every page with the masthead links to TV, and nginx routes /tv", () => {
  for (const f of htmlFiles.filter((h) => h !== "login.html")) assert.match(read(f), /<a id="tvlink" href="\/tv"/, `${f} has no TV entry`);
  assert.match(readFileSync(new URL("../nginx.conf", import.meta.url), "utf8"), /location = \/tv\s+\{[^}]*try_files \/tv\.html/);
});

test("home: every feed filter is a labelled control and the script saves them through /api/prefs", () => {
  const html = read("index.html"), js = read("js/home.js");
  const bar = /<div id="filters"[^>]*role="group"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  assert.ok(bar, "the filter bar is a labelled group");
  const controls = [...bar[1].matchAll(/<(?:input|select)\b[^>]*id="([\w-]+)"/g)].map((m) => m[1]);
  assert.deepEqual(controls, ["f-channel", "f-watched", "f-shorts", "f-live"]);
  assert.equal([...bar[1].matchAll(/<label>/g)].length, controls.length, "each control sits inside its own <label>");
  for (const id of controls) assert.ok(js.includes(`#${id}`), `home.js uses #${id}`);
  assert.match(js, /\/api\/prefs/);
  assert.match(js, /\/api\/feed/);
  assert.match(html, /<button type="button" id="more"/);
});

test("no page uses the same id twice (a template and a link once shared one, which broke lookups)", () => {
  for (const f of htmlFiles) {
    const ids = [...read(f).matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${f} repeats an id`);
  }
});

test("nginx rate-limits search and suggestions on their own exact locations", () => {
  const conf = readFileSync(new URL("../nginx.conf", import.meta.url), "utf8").replace(/#.*$/gm, "");
  assert.match(conf, /limit_req_zone [^;]*zone=search_req:\S+ rate=\d+r\/m;/);
  assert.match(conf, /limit_req_zone [^;]*zone=suggest_req:\S+ rate=\d+r\/m;/);
  assert.match(conf, /location = \/api\/search \{[^}]*limit_req zone=search_req burst=\d+[^}]*proxy_pass/s);
  assert.match(conf, /location = \/api\/search\/suggest \{[^}]*limit_req zone=suggest_req burst=\d+[^}]*proxy_pass/s);
});

test("suggest.js is fetched lazily, only when the search box is focused", () => {
  const lib = read("js/lib.js");
  assert.doesNotMatch(lib, /from "\.\/suggest\.js"/);
  assert.match(lib, /addEventListener\("focus", \(\) => import\("\.\/suggest\.js"\)/);
});

test("every dynamic import is a literal the budget test can follow", () => {
  for (const f of jsFiles) {
    const src = read(`js/${f}`);
    const all = [...src.matchAll(ANY_DYNAMIC_IMPORT)].length;
    assert.equal([...src.matchAll(LAZY_IMPORT)].length, all, `${f} has an import() the guardrails cannot classify (use a literal ./x.js path)`);
  }
});

test("the import patterns accept every quote style", () => {
  for (const q of ["'", '"', "`"]) {
    assert.deepEqual([...`import(${q}./a.js${q})`.matchAll(LAZY_IMPORT)].map((m) => m[1]), ["a.js"]);
    assert.deepEqual([...`import { x } from ${q}./b.js${q}`.matchAll(STATIC_IMPORT)].map((m) => m[1]), ["b.js"]);
  }
  assert.equal([...`import(name)`.matchAll(LAZY_IMPORT)].length, 0);
});
