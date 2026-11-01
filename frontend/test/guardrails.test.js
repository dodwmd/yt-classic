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

// Total shipped JavaScript, gzipped. Raise it deliberately, in a reviewed change, if you really need to.
const BUDGET_GZIP_BYTES = 8 * 1024;

test("total JavaScript stays within the size budget", () => {
  const total = jsFiles.reduce((n, f) => n + gzipSync(readFileSync(join(PUBLIC, "js", f))).length, 0);
  console.log(`# JS: ${jsFiles.length} files, ${total} bytes gzipped (budget ${BUDGET_GZIP_BYTES})`);
  assert.ok(total <= BUDGET_GZIP_BYTES, `JS is ${total} bytes gzipped, budget is ${BUDGET_GZIP_BYTES}`);
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
  const pairs = { "home.js": "index.html", "results.js": "results.html", "watch.js": "watch.html", "channel.js": "channel.html", "history.js": "history.html", "subscriptions.js": "subscriptions.html" };
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
