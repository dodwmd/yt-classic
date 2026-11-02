import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { getElementById: () => null, createElement: (tag) => ({ tag }) };
const { suggestions } = await import("../public/js/suggest.js");
const { subToggle } = await import("../public/js/sub.js");

const until = async (cond) => {
  for (let i = 0; i < 400 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.ok(cond(), "condition not reached in time");
};

function setup(responses) {
  const handlers = {};
  const box = { value: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, after(n) { this.list = n; }, addEventListener(e, f) { handlers[e] = f; } };
  const calls = [];
  const get = (path, signal) => {
    calls.push({ path, signal });
    return new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")));
      responses(path, resolve, reject);
    });
  };
  const list = { children: [], replaceChildren(...c) { this.children = c; } };
  globalThis.document = { getElementById: () => null, createElement: (tag) => (tag === "datalist" ? list : { tag }) };
  suggestions(box, get);
  const values = () => list.children.map((c) => c.value);
  return { box, handlers, calls, list, values };
}

test("an empty box lists recent searches on focus (fetched once), as option values only", async () => {
  const s = setup((path, resolve) => resolve({ searches: [{ id: 1, query: "<b>cats</b>" }, { id: 2, query: "dogs" }] }));
  assert.equal(s.box.attrs.list, "q-list");
  await until(() => s.values().length === 2); // loaded on the first focus: it shows the list at once
  assert.deepEqual(s.values(), ["<b>cats</b>", "dogs"]);
  assert.equal(s.calls[0].path, "/api/searches");
  s.handlers.focus();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.calls.length, 1, "recent searches are not fetched again");
});

test("typing is debounced, cancels the in-flight request, and shows at most 8 suggestions", async () => {
  const s = setup((path, resolve) => resolve({ suggestions: Array.from({ length: 12 }, (_, i) => `${decodeURIComponent(path.split("q=")[1])} ${i}`) }));
  s.box.value = "c";
  s.handlers.input();
  s.box.value = "ca";
  s.handlers.input();
  s.box.value = "cat ";
  s.handlers.input();
  await until(() => s.values().length);
  assert.equal(s.calls.length, 1, "three quick keystrokes make one request");
  assert.equal(s.calls[0].path, "/api/search/suggest?q=cat");
  assert.equal(s.values().length, 8);
  // a slow request is aborted by the next keystroke
  s.box.value = "dog";
  s.handlers.input();
  await until(() => s.calls.length === 2);
  assert.equal(s.calls[1].signal.aborted, false);
  s.box.value = "dogs";
  s.handlers.input();
  await until(() => s.calls.length === 3);
  assert.equal(s.calls[1].signal.aborted, true);
});

test("a failing suggest request leaves the box working", async () => {
  const s = setup((path, resolve, reject) => reject(new Error("503")));
  s.box.value = "x";
  s.handlers.input();
  await until(() => s.calls.length === 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(s.values(), []);
  s.box.value = "";
  s.handlers.focus();
  await until(() => s.calls.length === 2);
  assert.equal(s.calls[1].path, "/api/searches", "a failed recent lookup is retried on the next focus");
});

test("subToggle: the label follows the server's answer, and a failure keeps it and says why", async () => {
  let handler;
  const button = { addEventListener: (_, f) => (handler = f), textContent: "" };
  const err = { textContent: "" };
  const answers = [{ ok: true, status: 200, json: async () => ({ subscribed: true }) }, { ok: false, status: 500, json: async () => ({ error: "Limit reached" }) }];
  const sent = [];
  globalThis.fetch = async (path, init) => (sent.push([path, String(init.body)]), answers.shift());
  subToggle(button, "UCx", false, err);
  assert.equal(button.textContent, "Subscribe");
  await handler();
  assert.equal(button.textContent, "Unsubscribe");
  assert.deepEqual(sent[0], ["/api/subscribe", "id=UCx"]);
  await handler();
  assert.equal(button.textContent, "Unsubscribe");
  assert.equal(err.textContent, "Limit reached");
  assert.equal(button.disabled, false);
  assert.equal(sent[1][0], "/api/unsubscribe");
});
