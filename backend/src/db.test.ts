import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, closeDb, getDb, migrate, openDb } from "./db.ts";
import { writeFileSync } from "node:fs";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "yt-db-"));
  process.env.DATA_DIR = dir;
});
afterEach(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
});

const versions = (db: DatabaseSync) =>
  (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: number }[]).map((r) => r.version);

test("migrations apply and are idempotent", () => {
  const db = new DatabaseSync(":memory:");
  assert.equal(migrate(db), MIGRATIONS.at(-1)!.version);
  const before = versions(db);
  assert.deepEqual(before, MIGRATIONS.map((m) => m.version));
  migrate(db);
  assert.deepEqual(versions(db), before);
  db.close();
});

test("later migrations are applied on top, in order, once", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const extra = [...MIGRATIONS, { version: 2, sql: "CREATE TABLE history (id TEXT PRIMARY KEY)" }];
  assert.equal(migrate(db, extra), 2);
  assert.equal(migrate(db, extra), 2);
  assert.deepEqual(versions(db), [1, 2]);
  db.close();
});

test("a failing migration rolls back and is not recorded", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db);
  const bad = [...MIGRATIONS, { version: 2, sql: "CREATE TABLE ok (a); CREATE TABLE ok (b);" }];
  assert.throws(() => migrate(db, bad), /migration 2 failed/);
  assert.deepEqual(versions(db), [1]);
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").get(), undefined);
  db.close();
});

test("the database uses WAL and survives reopening", () => {
  const db = getDb();
  assert.equal((db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode, "wal");
  assert.equal((db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout, 5000);
  db.prepare("INSERT INTO meta (key, value) VALUES ('k', 'v')").run();
  closeDb();
  const again = openDb(join(dir, "yt.db"));
  assert.equal((again.prepare("SELECT value FROM meta WHERE key = 'k'").get() as { value: string }).value, "v");
  again.close();
});

test("a loser of the migration race skips what the winner applied", () => {
  const path = join(dir, "race.db");
  const a = new DatabaseSync(path);
  const b = new DatabaseSync(path);
  a.exec("PRAGMA journal_mode = WAL");
  b.exec("PRAGMA busy_timeout = 5000");
  // b has read "version 0" and is about to take the lock when a runs the whole migration.
  assert.equal(migrate(b, MIGRATIONS, () => void migrate(a)), MIGRATIONS.at(-1)!.version);
  assert.deepEqual(versions(b), MIGRATIONS.map((m) => m.version));
  a.close();
  b.close();
});

test("getDb refuses after a final close, but closeDb is idempotent and reopens otherwise", () => {
  closeDb(); // idle: nothing open, must not throw
  closeDb();
  assert.ok(getDb());
  closeDb();
  assert.ok(getDb());
  closeDb(true);
  closeDb(true);
  assert.throws(() => getDb(), /closed/);
  closeDb(); // clears the flag (tests only)
  assert.ok(getDb());
});

test("tests cannot fall back to the real ./data", () => {
  delete process.env.DATA_DIR;
  assert.throws(() => getDb(), /DATA_DIR must be set/);
});

test("a DATA_DIR that is a file is a clear error", () => {
  const f = join(dir, "file");
  writeFileSync(f, "x");
  process.env.DATA_DIR = f;
  assert.throws(() => getDb(), /cannot open the database/);
});
