import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { existsSync, statSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SUBS, MAX_TITLE, addSub, listSubs, removeSub } from "./store.ts";
import { closeDb, getDb, onOpen } from "./db.ts";

// Well-formed channel ids ("UC" + 22 chars).
const uc = (n: number | string) => "UC" + String(n).padStart(22, "0");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-"));
  process.env.DATA_DIR = dir;
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

test("subscriptions add/dedupe/remove", async () => {
  assert.deepEqual(await listSubs(), []);
  assert.equal(await addSub({ id: uc("1"), title: "One" }), "added");
  assert.equal(await addSub({ id: uc("1"), title: "One" }), "exists");
  await addSub({ id: uc("2"), title: "Two" });
  assert.equal((await listSubs()).length, 2);
  await removeSub(uc("1"));
  assert.deepEqual(await listSubs(), [{ id: uc("2"), title: "Two" }]);
});

test("parallel writes are all kept (no lost updates, no ENOENT)", async () => {
  await Promise.all(Array.from({ length: 10 }, (_, i) => addSub({ id: uc(i), title: `T${i}` })));
  assert.equal((await listSubs()).length, 10);
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
});

test("a corrupt file is moved aside instead of breaking everything", async () => {
  writeFileSync(join(dir, "subscriptions.json"), '[{"id":"UC1","ti');
  assert.deepEqual(await listSubs(), []);
  assert.ok(readdirSync(dir).some((f) => f.includes(".corrupt-")));
  await addSub({ id: uc("2"), title: "Two" }); // and writing works again
  assert.equal((await listSubs()).length, 1);
});

test("a wrong-shaped file is treated as corrupt", async () => {
  writeFileSync(join(dir, "subscriptions.json"), '{"not":"an array"}');
  assert.deepEqual(await listSubs(), []);
});

test("the subscription limit is enforced", async () => {
  for (let i = 0; i < MAX_SUBS; i++) await addSub({ id: uc(i), title: `T${i}` });
  assert.equal(await addSub({ id: uc("extra"), title: "x" }), "full");
  assert.equal((await listSubs()).length, MAX_SUBS);
  await removeSub(uc("0"));
  assert.equal(await addSub({ id: uc("extra"), title: "x" }), "added");
});

test("order is insertion order and removing an unknown id is a no-op", async () => {
  for (const id of [uc("b"), uc("a"), uc("c")]) await addSub({ id, title: id });
  await removeSub(uc("none"));
  assert.deepEqual((await listSubs()).map((s) => s.id), [uc("b"), uc("a"), uc("c")]);
});

test("an existing subscriptions.json is imported once and renamed", async () => {
  const subs = [{ id: uc("1"), title: "One" }, { id: uc("2"), title: "Two" }];
  writeFileSync(join(dir, "subscriptions.json"), JSON.stringify(subs));
  assert.deepEqual(await listSubs(), subs);
  assert.equal(existsSync(join(dir, "subscriptions.json")), false);
  assert.equal(readFileSync(join(dir, "subscriptions.json.migrated"), "utf8"), JSON.stringify(subs));
  await removeSub(uc("1"));
  closeDb(); // restart
  assert.deepEqual(await listSubs(), [{ id: uc("2"), title: "Two" }]);
});

test("a re-appearing json file does not resurrect removed subscriptions", async () => {
  writeFileSync(join(dir, "subscriptions.json"), JSON.stringify([{ id: uc("1"), title: "One" }]));
  await listSubs();
  await removeSub(uc("1"));
  closeDb();
  writeFileSync(join(dir, "subscriptions.json"), JSON.stringify([{ id: uc("1"), title: "One" }]));
  assert.deepEqual(await listSubs(), []);
  assert.equal(existsSync(join(dir, "subscriptions.json")), false);
});

test("the limit holds when two processes add at once (BEGIN IMMEDIATE across connections)", async () => {
  const run = (offset: number) =>
    promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(import.meta.dirname, "store.child.ts"), String(offset), "350"], {
      env: { ...process.env, DATA_DIR: dir },
    }).then((r) => JSON.parse(r.stdout) as Record<string, number>);
  // Distinct ids, 700 attempts for 500 slots: a check-then-insert without the write lock overshoots or errors.
  const [a, b] = await Promise.all([run(0), run(350)]);
  assert.equal(a.added + b.added, MAX_SUBS);
  assert.equal(a.full + b.full, 700 - MAX_SUBS);
  assert.equal((await listSubs()).length, MAX_SUBS);
});

test("two processes racing for the same ids add each only once", async () => {
  const run = () =>
    promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(import.meta.dirname, "store.child.ts"), "0", "100"], {
      env: { ...process.env, DATA_DIR: dir },
    }).then((r) => JSON.parse(r.stdout) as Record<string, number>);
  const [a, b] = await Promise.all([run(), run()]);
  assert.equal(a.added + b.added, 100);
  assert.equal(a.exists + b.exists, 100);
});

test("invalid ids are rejected and titles are capped", async () => {
  await assert.rejects(addSub({ id: "UC1", title: "bad" }), /invalid channel id/);
  await assert.rejects(addSub({ id: uc(1) + "/../x", title: "bad" }), /invalid channel id/);
  await addSub({ id: uc(1), title: "x".repeat(1000) });
  assert.equal((await listSubs())[0].title.length, MAX_TITLE);
});

test("import skips invalid rows, keeps the valid ones and caps titles", async () => {
  const rows = [{ id: uc(1), title: "ok" }, { id: "UC1/../../evil", title: "bad" }, { id: uc(2), title: "y".repeat(500) }];
  writeFileSync(join(dir, "subscriptions.json"), JSON.stringify(rows));
  const real = console.error;
  const logged: string[] = [];
  console.error = (m: string) => void logged.push(String(m));
  try {
    const subs = await listSubs();
    assert.deepEqual(subs.map((s) => s.id), [uc(1), uc(2)]);
    assert.equal(subs[1].title.length, MAX_TITLE);
  } finally {
    console.error = real;
  }
  assert.ok(logged.some((m) => m.includes("skipped 1 entries")));
});

test("a failed import rolls back completely and is retried on the next open", async () => {
  getDb().exec(`CREATE TRIGGER boom BEFORE INSERT ON subscriptions WHEN NEW.title = 'boom' BEGIN SELECT RAISE(ABORT, 'boom'); END`);
  closeDb();
  writeFileSync(join(dir, "subscriptions.json"), JSON.stringify([{ id: uc(1), title: "a" }, { id: uc(2), title: "boom" }]));
  await assert.rejects(listSubs(), /boom/);
  await assert.rejects(listSubs(), /boom/); // still failing, not silently "empty": the connection was discarded
  assert.ok(existsSync(join(dir, "subscriptions.json")), "file is left in place");
  const raw = new DatabaseSync(join(dir, "yt.db"));
  assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM subscriptions").get() as { n: number }).n, 0, "nothing half-imported");
  assert.equal(raw.prepare("SELECT 1 FROM meta WHERE key = 'subscriptions_json_imported'").get(), undefined);
  raw.exec("DROP TRIGGER boom");
  raw.close();
  assert.deepEqual((await listSubs()).map((s) => s.id), [uc(1), uc(2)]);
});

test("a hook that throws once fails that open, then the next call retries it", async () => {
  let calls = 0;
  const off = onOpen(() => {
    if (calls++ === 0) throw new Error("first time fails");
  });
  try {
    await assert.rejects(listSubs(), /first time fails/);
    assert.deepEqual(await listSubs(), []);
    assert.equal(calls, 2);
  } finally {
    off();
  }
});

test("a hook registered while the database is open runs immediately", async () => {
  await listSubs();
  let ran = 0;
  const off = onOpen(() => void ran++);
  off();
  assert.equal(ran, 1);
});

test("an unusable DATA_DIR gives a clear error and the process keeps working", async () => {
  const file = join(dir, "not-a-dir");
  writeFileSync(file, "x");
  process.env.DATA_DIR = file;
  await assert.rejects(listSubs(), /cannot open the database/);
  await assert.rejects(addSub({ id: uc(1), title: "t" }), /cannot open the database/);
  await assert.rejects(removeSub(uc(1)), /cannot open the database/);
  process.env.DATA_DIR = dir; // and it recovers once the problem is gone
  assert.equal(await addSub({ id: uc(1), title: "t" }), "added");
});

test("the database and a newly created data dir are owner-only", async () => {
  process.env.DATA_DIR = join(dir, "fresh", "data");
  await listSubs();
  assert.equal(statSync(process.env.DATA_DIR).mode & 0o777, 0o700);
  assert.equal(statSync(join(process.env.DATA_DIR, "yt.db")).mode & 0o777, 0o600);
  assert.equal(statSync(join(process.env.DATA_DIR, "yt.db-wal")).mode & 0o777, 0o600);
});
