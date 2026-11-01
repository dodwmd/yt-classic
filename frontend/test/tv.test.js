import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { getElementById: () => null }; // tv.js and lib.js look elements up when they load; no #tvbox: nothing is wired
const { tvController } = await import("../public/js/tv.js");

const tick = () => new Promise((r) => setImmediate(r));
function harness(overrides = {}) {
  const log = { shown: [], finished: [], busy: [], fetches: 0 };
  const pending = [];
  const c = tvController({
    fetchNext: (signal) => new Promise((resolve, reject) => {
      log.fetches++;
      const p = { resolve, reject, signal };
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      pending.push(p);
    }),
    show: (r) => log.shown.push(r.video),
    finish: (m) => log.finished.push(m),
    wait: async () => {},
    busy: (b) => log.busy.push(b),
    ...overrides,
  });
  return { c, log, pending };
}
const video = (id) => ({ video: id, quality: 720 });

test("two Skips while a request is in flight make one request and play one video", async () => {
  const { c, log, pending } = harness();
  const a = c.next(), b = c.next(), d = c.next();
  await tick();
  assert.equal(log.fetches, 1, "re-entry is ignored");
  pending[0].resolve(video("A"));
  await Promise.all([a, b, d]);
  assert.deepEqual(log.shown, ["A"]);
  assert.deepEqual(log.busy, [true, false], "Skip is disabled while the request runs, enabled after");
  c.next();
  await tick();
  assert.equal(log.fetches, 2, "the next Skip after it finished works");
});

test("Stop with a request in flight: the response never plays, even from a server that ignores the abort", async () => {
  const late = [];
  const { c, log } = harness({ fetchNext: (signal) => new Promise((resolve) => late.push({ resolve, signal })) });
  const p = c.next();
  await tick();
  c.stop();
  assert.ok(late[0].signal.aborted, "the request was aborted");
  late[0].resolve(video("LATE")); // answers anyway
  await p;
  await tick();
  assert.deepEqual(log.shown, [], "a stale response must not play after Stop");
  assert.deepEqual(log.finished, []);
  await c.next();
  assert.equal(late.length, 1, "and nothing is requested after Stop");
});

test("a failure after Stop does not retry or finish with a message", async () => {
  const { c, log, pending } = harness();
  const p = c.next();
  await tick();
  c.stop();
  pending[0].reject(new Error("boom"));
  await p;
  assert.deepEqual(log.finished, []);
  assert.equal(log.fetches, 1);
});

test("three failures in a row stop TV; a video that plays resets the count", async () => {
  const { c, log, pending } = harness();
  const first = c.next();
  for (let i = 0; i < 3; i++) {
    await tick();
    pending[i].reject(new Error("no luck"));
  }
  await first;
  assert.equal(log.fetches, 3);
  assert.match(log.finished[0], /TV stopped: no luck \(3 failures in a row\)/);
  assert.equal(c.over, true);

  const h = harness();
  let p = h.c.next();
  await tick(); h.pending[0].reject(new Error("x"));
  await tick(); h.pending[1].reject(new Error("x"));
  await tick(); h.pending[2].resolve(video("OK"));
  await p;
  h.c.playing(); // really played: the streak is over
  p = h.c.next();
  await tick(); h.pending[3].reject(new Error("x"));
  await tick(); h.pending[4].reject(new Error("x"));
  await tick(); h.pending[5].resolve(video("OK2"));
  await p;
  assert.deepEqual(h.log.shown, ["OK", "OK2"]);
  assert.deepEqual(h.log.finished, []);
});

test("need-subscriptions ends TV at once with the server's message", async () => {
  const { c, log, pending } = harness();
  const p = c.next();
  await tick();
  pending[0].reject(Object.assign(new Error("Subscribe to 1 more channel to turn on TV."), { code: "need-subscriptions" }));
  await p;
  assert.deepEqual(log.finished, ["Subscribe to 1 more channel to turn on TV."], "nothing played yet: no 'stopped' prefix");
  const h = harness();
  const q = h.c.next();
  await tick(); h.pending[0].resolve(video("A")); await q;
  const r = h.c.next();
  await tick(); h.pending[1].reject(Object.assign(new Error("Subscribe to 1 more channel to turn on TV."), { code: "need-subscriptions" })); await r;
  assert.deepEqual(h.log.finished, ["TV stopped. Subscribe to 1 more channel to turn on TV."]);
  assert.equal(h.log.fetches, 2, "no retry");
});

test("a video that will not play counts as a failure and moves on; while a request runs it is ignored", async () => {
  const { c, log, pending } = harness();
  const p = c.next();
  await tick(); pending[0].resolve(video("A")); await p;
  c.broken("stopped");
  await tick();
  assert.equal(log.fetches, 2, "asks for another video");
  c.broken("stopped"); // the old one erroring again while the request runs
  assert.equal(log.fetches, 2);
  pending[1].resolve(video("B"));
  await tick();
  c.broken("stopped"); c.broken("stopped");
  await tick(); pending[2]?.resolve(video("C")); await tick();
  assert.ok(c.over || log.fetches >= 3);
});

test("a show() that throws is not a fetch failure", async () => {
  const h = harness({ show: () => { throw new Error("storage full"); } });
  const p = h.c.next();
  await tick();
  h.pending[0].resolve(video("A"));
  await assert.rejects(p, /storage full/);
  assert.deepEqual(h.log.finished, []);
  assert.equal(h.log.fetches, 1);
});
