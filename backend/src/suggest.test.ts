import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { MAX_SUGGESTIONS, parseSuggest, resetSuggest, suggest } from "./suggest.ts";

// Real response of suggestqueries-clients6.youtube.com for q=veritas (trimmed)
const REAL = 'window.google.ac.h(["veritas",[["veritasium",0,[512,433]],["veritasium blue led",0,[512]],["veritas",0,[512,433]]],{"k":1}])';

beforeEach(() => resetSuggest());

test("parseSuggest reads the JSONP wrapper and ignores junk", () => {
  assert.deepEqual(parseSuggest(REAL), ["veritasium", "veritasium blue led", "veritas"]);
  for (const bad of ["", "nope", "f(", "f()", "f(not json)", "f({})", 'f(["q",5])', 'f(["q",[[1],[null],"x"]])']) assert.deepEqual(parseSuggest(bad), [], bad);
  const many = `f(["q",[${Array.from({ length: 20 }, (_, i) => `["s${i}",0]`).join(",")}],{}])`;
  assert.equal(parseSuggest(many).length, MAX_SUGGESTIONS);
});

test("suggest asks Google once per query within the cache window, with a timeout signal", async () => {
  const real = globalThis.fetch;
  const seen: { url: string; signal: boolean }[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => (seen.push({ url: input instanceof Request ? input.url : String(input), signal: !!init?.signal }), new Response(REAL))) as typeof fetch;
  try {
    assert.equal((await suggest("Veritas", "", 1000))?.length, 3);
    await suggest("veritas ", "", 2000);
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /^https:\/\/suggestqueries-clients6\.youtube\.com\/complete\/search\?client=youtube&ds=yt&q=veritas$/);
    assert.equal(seen[0].signal, true);
    await suggest("veritas", "", 1000 + 6 * 60_000); // expired
    assert.equal(seen.length, 2);
  } finally {
    globalThis.fetch = real;
  }
});

test("suggest: failure and non-200 give an empty list, remembered only briefly; a flood is limited", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  let fail = true;
  globalThis.fetch = (async () => (calls++, fail ? Promise.reject(new TypeError("down")) : new Response("busy", { status: 503 }))) as typeof fetch;
  try {
    assert.deepEqual(await suggest("a", "", 1000), []);
    assert.deepEqual(await suggest("a", "", 2000), []);
    assert.equal(calls, 1);
    fail = false;
    assert.deepEqual(await suggest("a", "", 40_000), [], "a failure is retried after 30 s");
    assert.equal(calls, 2);
    for (let i = 0; i < 200; i++) await suggest(`flood${i}`, "", 50_000);
    assert.ok(calls < 130, `calls=${String(calls)}`);
  } finally {
    globalThis.fetch = real;
  }
});

test("a query is never logged", async () => {
  const real = globalThis.fetch;
  const logged: string[] = [];
  const realErr = console.error, realLog = console.log, realWarn = console.warn;
  console.error = console.log = console.warn = (...a: unknown[]) => void logged.push(a.join(" "));
  globalThis.fetch = (async () => Promise.reject(new Error("boom"))) as typeof fetch;
  try {
    await suggest("secret-query", "");
  } finally {
    Object.assign(console, { error: realErr, log: realLog, warn: realWarn });
    globalThis.fetch = real;
  }
  assert.deepEqual(logged, []);
});

test("one client is limited on its own, then everyone together; cache hits cost nothing", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => (calls++, new Response(REAL))) as typeof fetch;
  try {
    for (let i = 0; i < 30; i++) assert.ok(await suggest(`own${i}`, "10.0.0.1", 1000));
    assert.equal(await suggest("own30", "10.0.0.1", 2000), null, "the 31st request in a minute from one client");
    assert.ok(await suggest("own0", "10.0.0.1", 2000), "a cached answer is still served");
    assert.ok(await suggest("other", "10.0.0.2", 2000), "another client is unaffected");
    for (let i = 0; i < 100; i++) await suggest(`many${i}`, `10.1.0.${i % 50}`, 3000);
    assert.equal(await suggest("one-too-many", "10.9.9.9", 3000), null, "the global limit");
    assert.ok(await suggest("later", "10.0.0.1", 70_000), "the window moves on");
    assert.ok(calls <= 122, `${calls} calls reached Google`);
  } finally {
    globalThis.fetch = real;
  }
});

test("a huge or endless answer is read only up to 64 KB", async () => {
  const real = globalThis.fetch;
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      pulled++;
      c.enqueue(new Uint8Array(16 * 1024).fill(32));
      if (pulled > 10_000) c.close();
    },
  });
  globalThis.fetch = (async () => new Response(body)) as typeof fetch;
  try {
    assert.deepEqual(await suggest("endless", "", 1000), []);
    assert.ok(pulled < 20, `read ${pulled} chunks`);
  } finally {
    globalThis.fetch = real;
  }
});
