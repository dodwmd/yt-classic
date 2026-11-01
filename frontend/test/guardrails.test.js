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
  const pairs = { "home.js": "index.html", "results.js": "results.html", "watch.js": "watch.html", "channel.js": "channel.html" };
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
