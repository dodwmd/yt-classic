import { chmodSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";

/**
 * The single SQLite connection (DATA_DIR/yt.db). node:sqlite is synchronous, so every statement is atomic with
 * respect to the event loop; there is no pool and no locking to think about inside this process.
 *
 * Migrations are an ordered list. Never edit or reorder an applied entry: append a new one with the next version.
 */
export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE subscriptions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL
      );
      CREATE TABLE cache (
        key TEXT PRIMARY KEY,
        val TEXT NOT NULL,
        exp INTEGER NOT NULL,
        used INTEGER NOT NULL
      );
      CREATE INDEX cache_exp ON cache (exp);
      CREATE INDEX cache_used ON cache (used);
    `,
  },
];

/**
 * Applies every migration newer than the recorded version, each in its own transaction. Safe to call repeatedly
 * and from several processes at once: the version is re-read inside the write lock, so a process that lost the
 * race skips what the winner already applied. `beforeLock` is a test seam that runs right before taking the lock.
 */
export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS, beforeLock?: (m: Migration) => void): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const latest = () => ((db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null }).v ?? 0);
  let current = latest();
  const insert = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    beforeLock?.(m);
    db.exec("BEGIN IMMEDIATE");
    try {
      current = latest(); // another process may have applied this while we waited for the lock
      if (m.version > current) {
        db.exec(m.sql);
        insert.run(m.version, Date.now());
        current = m.version;
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} failed: ${(e as Error).message}`, { cause: e });
    }
  }
  return current;
}

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 5000"); // first, so the pragmas below also wait for a competing opener
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL"); // safe with WAL; a crash may lose the last commits, never corrupt
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db);
  } catch (e) {
    db.close();
    throw e;
  }
  return db;
}

const statements = new WeakMap<DatabaseSync, Map<string, StatementSync>>();

/** Prepared statements are compiled once per connection and reused. */
export function stmt(db: DatabaseSync, sql: string): StatementSync {
  let m = statements.get(db);
  if (!m) statements.set(db, (m = new Map()));
  let s = m.get(sql);
  if (!s) m.set(sql, (s = db.prepare(sql)));
  return s;
}

let current: { path: string; db: DatabaseSync } | null = null;
let closed = false;
const hooks = new Set<(db: DatabaseSync) => void>();

/**
 * Registers a function that runs once for every freshly opened connection (after migrations), e.g. a one-time
 * import. If the connection is already open it runs right away, so import order does not matter. A hook that
 * throws fails getDb() (or, for a late registration, discards the connection); the next call retries. Returns an unregister function.
 */
export function onOpen(fn: (db: DatabaseSync) => void): () => void {
  hooks.add(fn);
  if (current) {
    try {
      fn(current.db);
    } catch (e) {
      console.error(`database hook failed: ${(e as Error).message}`);
      closeDb(); // the next getDb() reopens and retries every hook
    }
  }
  return () => void hooks.delete(fn);
}

/** Where the database lives. Tests must always set DATA_DIR so they can never touch the real ./data. */
function dataDir(): string {
  const dir = process.env.DATA_DIR;
  if (!dir && process.env.NODE_TEST_CONTEXT) throw new Error("DATA_DIR must be set when running tests");
  return resolve(dir ?? "./data");
}

/** yt.db and its -wal/-shm may hold personal data: owner-only. The sidecar files inherit the main file's mode. */
function restrict(path: string): void {
  for (const f of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      chmodSync(f, 0o600);
    } catch {
      // not there, or not ours to change (bind mounts): the directory permissions still apply
    }
  }
}

/** The connection for the current DATA_DIR, opened on first use. Throws if it cannot be opened (or after shutdown). */
export function getDb(): DatabaseSync {
  if (closed) throw new Error("database is closed (shutting down)");
  const dir = dataDir();
  const path = join(dir, "yt.db");
  if (current?.path === path) return current.db;
  closeDb(); // DATA_DIR changed (tests); production never gets here twice
  let db: DatabaseSync | undefined;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 }); // only affects directories we create
    db = openDb(path);
    restrict(path);
    for (const fn of hooks) fn(db);
  } catch (e) {
    try {
      db?.close();
    } catch {
      // already failing
    }
    throw new Error(`cannot open the database in ${dir}: ${(e as Error).message}`, { cause: e });
  }
  current = { path, db };
  return db;
}

/**
 * Checkpoints the WAL and closes the connection. Idempotent. A later getDb() reopens it, unless `final` is set
 * (process shutdown): then getDb() throws, so an in-flight request cannot reopen the database behind our back.
 */
export function closeDb(final = false): void {
  closed = final;
  const c = current;
  current = null;
  if (!c) return;
  try {
    c.db.close();
  } catch (e) {
    console.error(`closing the database failed: ${(e as Error).message}`);
  }
}
