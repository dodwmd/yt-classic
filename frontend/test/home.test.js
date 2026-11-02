import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.document = { getElementById: () => null }; // no #home: the page is not wired, only the controller is imported
const { feedController } = await import("../public/js/home.js");

const tick = () => new Promise((r) => setImmediate(r));
function harness(next) {
  const paints = [], pending = [];
  const c = feedController({
    next,
    fetchPage: (before) => new Promise((resolve, reject) => pending.push({ before, resolve, reject })),
    paint: (s) => paints.push(s),
  });
  return { c, paints, pending };
}
const page = (ids, next) => ({ items: ids.map((id) => ({ id })), next });
const last = (paints) => paints[paints.length - 1];

test("a failed filter change drops the old cursor, so Load more cannot combine it with the new filters", async () => {
  const { c, paints, pending } = harness("CURSOR-1");
  const a = c.load(false);
  pending[0].reject(new Error("boom"));
  await a;
  assert.equal(c.next, undefined);
  assert.equal(last(paints).error, "boom");
  assert.equal(last(paints).next, undefined, "the button is hidden");
  await c.load(true);
  assert.equal(pending.length, 1, "Load more does nothing without a cursor");
});

test("a failed Load more keeps its cursor so it can be tried again", async () => {
  const { c, pending } = harness("C1");
  const a = c.load(true);
  assert.equal(pending[0].before, "C1");
  pending[0].reject(new Error("offline"));
  await a;
  assert.equal(c.next, "C1");
});

test("toggle, Load more, toggle: the late responses never paint", async () => {
  const { c, paints, pending } = harness("C1");
  const t1 = c.load(false); // toggle
  const more = c.load(true); // Load more is ignored: the refresh runs
  assert.equal(pending.length, 1, "no Load more while a request is running");
  pending[0].resolve(page(["a"], "C2"));
  await Promise.all([t1, more]);
  const m = c.load(true); // a real Load more
  assert.equal(pending[1].before, "C2");
  const t2 = c.load(false); // toggle again while it is in flight
  pending[2].resolve(page(["z"], undefined)); // the new filter answers first
  await t2;
  pending[1].resolve(page(["late"], "C9")); // the old Load more answers late
  await m;
  await tick();
  assert.deepEqual(paints.filter((p) => p.items).map((p) => p.items.map((i) => i.id)), [["a"], ["z"]], "the late page was dropped");
  assert.equal(c.next, undefined, "its cursor was dropped too");
});

test("a late failure of a superseded request does not show an error", async () => {
  const { c, paints, pending } = harness("C1");
  const old = c.load(false);
  const fresh = c.load(false);
  pending[1].resolve(page(["ok"], undefined));
  await fresh;
  pending[0].reject(new Error("stale failure"));
  await old;
  assert.ok(paints.every((p) => !p.error));
});
