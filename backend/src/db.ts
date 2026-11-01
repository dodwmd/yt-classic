import { chmodSync, existsSync, mkdirSync, renameSync } from "node:fs";
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
  {
    // Byte size per row, so the budget prune never has to read the values.
    version: 2,
    sql: `
      ALTER TABLE cache ADD COLUMN size INTEGER NOT NULL DEFAULT 0;
      UPDATE cache SET size = length(CAST(val AS BLOB));
    `,
  },
  {
    // Watch history: one row per video, updated in place as it is watched.
    version: 3,
    sql: `
      CREATE TABLE history (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_title TEXT NOT NULL,
        thumb TEXT NOT NULL,
        duration INTEGER NOT NULL,
        position INTEGER NOT NULL,
        last_watched INTEGER NOT NULL,
        completed INTEGER NOT NULL DEFAULT 0,
        watch_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX history_last ON history (last_watched);
    `,
  },
  {
    // User-curated playlists. Id 1 is the built-in "Watch later" (cannot be renamed or deleted). Items keep a copy of
    // the video's title/channel/thumb/duration so a list renders without any API call.
    version: 4,
    sql: `
      CREATE TABLE playlists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE,
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        position INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO playlists (id, name, name_key, created, updated, position) VALUES (1, 'Watch later', 'watch later', 0, 0, 0);
      CREATE TABLE playlist_items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        playlist_id INTEGER NOT NULL REFERENCES playlists (id) ON DELETE CASCADE,
        video_id TEXT NOT NULL,
        added INTEGER NOT NULL,
        position INTEGER NOT NULL,
        title TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_title TEXT NOT NULL,
        thumb TEXT NOT NULL,
        duration INTEGER NOT NULL,
        UNIQUE (playlist_id, video_id)
      );
      CREATE INDEX playlist_items_order ON playlist_items (playlist_id, position, seq);
      CREATE INDEX playlist_items_video ON playlist_items (video_id);
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

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const isBusy = (e: unknown) => /locked|busy/i.test((e as Error).message ?? "");

/**
 * Opens and prepares the database. Switching a brand-new file to WAL can fail with "database is locked" without
 * honouring the busy timeout when another process is doing the same, so a busy open is simply retried.
 */
export function openDb(path: string): DatabaseSync {
  for (let attempt = 1; ; attempt++) {
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout = 5000"); // first, so the pragmas below also wait for a competing opener
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = NORMAL"); // safe with WAL; a crash may lose the last commits, never corrupt
      db.exec("PRAGMA foreign_keys = ON");
      migrate(db);
      return db;
    } catch (e) {
      db.close();
      if (!isBusy(e) || attempt >= 40) throw e;
      pause(10 + Math.floor(Math.random() * 40));
    }
  }
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

/** SQLITE_CORRUPT (11) or SQLITE_NOTADB (26): the file is damaged, as opposed to busy, locked or unwritable. */
const isCorrupt = (e: unknown): boolean => {
  const err = e as { errcode?: number; message?: string };
  return err.errcode === 11 || err.errcode === 26 || /not a database|malformed|corrupt/i.test(err.message ?? "");
};

/** Keeps a damaged database (with its -wal/-shm) for inspection so a fresh one can be created. */
function moveAside(path: string): string {
  const bak = `${path}.corrupt-${Date.now()}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) renameSync(path + suffix, bak + suffix);
  }
  return bak;
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
    try {
      db = openDb(path);
    } catch (e) {
      // Like the old JSON file: don't take the site down over a damaged database. Subscriptions are lost, but
      // the copy is kept next to it.
      if (!isCorrupt(e)) throw e;
      console.error(`yt.db is damaged (${(e as Error).message}); moved to ${moveAside(path)} and starting fresh`);
      db = openDb(path);
    }
    restrict(path);
    // Visible to getDb() while the hooks run (they may call helpers that use it); undone if any hook fails.
    current = { path, db };
    for (const fn of hooks) fn(db);
  } catch (e) {
    current = null;
    try {
      db?.close();
    } catch {
      // already failing
    }
    throw new Error(`cannot open the database in ${dir}: ${(e as Error).message}`, { cause: e });
  }
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

/** Cheap liveness probe for /healthz: throws if the database cannot be opened or queried. */
export function pingDb(): void {
  stmt(getDb(), "SELECT 1").get();
}
