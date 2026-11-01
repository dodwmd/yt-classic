import { mkdirSync } from "node:fs";
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

/** Applies every migration newer than the recorded version, each in its own transaction. Safe to call repeatedly. */
export function migrate(db: DatabaseSync, migrations: Migration[] = MIGRATIONS): number {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  const current = row.v ?? 0;
  const insert = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(m.sql);
      insert.run(m.version, Date.now());
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`migration ${m.version} failed: ${(e as Error).message}`, { cause: e });
    }
  }
  return Math.max(current, ...migrations.map((m) => m.version));
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
const opened = new Set<(db: DatabaseSync) => void>();

/** Runs once for every freshly opened connection (after migrations); used for one-time data imports. */
export function onOpen(fn: (db: DatabaseSync) => void): void {
  opened.add(fn);
}

/** The connection for the current DATA_DIR, opened on first use. Throws if the database cannot be opened. */
export function getDb(): DatabaseSync {
  const dir = resolve(process.env.DATA_DIR ?? "./data");
  const path = join(dir, "yt.db");
  if (current?.path === path) return current.db;
  closeDb(); // DATA_DIR changed (tests); production never gets here twice
  mkdirSync(dir, { recursive: true });
  const db = openDb(path);
  current = { path, db };
  for (const fn of opened) fn(db);
  return db;
}

/** Checkpoints the WAL and closes the connection. A later getDb() reopens it. */
export function closeDb(): void {
  const c = current;
  current = null;
  if (!c) return;
  try {
    c.db.close();
  } catch (e) {
    console.error(`closing the database failed: ${(e as Error).message}`);
  }
}
