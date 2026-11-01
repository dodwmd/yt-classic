import { getDb, stmt } from "./db.ts";

const MAX_ENTRIES = 500;
const MAX_ROWS = 5000; // persisted entries kept on disk
const MAX_VALUE_BYTES = 1_000_000;
const PRUNE_EVERY = 200; // writes between pruning passes
const NEGATIVE_TTL_MS = 60_000;

const store = new Map<string, { exp: number; val: unknown }>();
const pending = new Map<string, Promise<unknown>>();

// null / [] / empty result pages are usually a transient miss or breakage upstream, so they only live briefly.
const isEmpty = (v: unknown): boolean =>
  v == null ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && Array.isArray((v as { items?: unknown }).items) && (v as { items: unknown[] }).items.length === 0);

// The disk copy is an optimisation: any failure is logged (once per kind) and the in-memory cache carries on.
let lastWarn = "";
function diskFailed(what: string, e: unknown): void {
  const msg = `cache: ${what} failed: ${(e as Error).message}`;
  if (msg !== lastWarn) console.error(`${msg} (continuing with the in-memory cache)`);
  lastWarn = msg;
}

let restored = 0;
let restoredTimer: NodeJS.Timeout | undefined;
function noteRestored(): void {
  restored++;
  restoredTimer ??= setTimeout(() => {
    console.log(`cache: restored ${restored} entries from disk`);
    restored = 0;
    restoredTimer = undefined;
  }, 1000).unref();
}

function readDisk(key: string): { exp: number; val: unknown } | undefined {
  try {
    const db = getDb();
    const row = stmt(db, "SELECT val, exp FROM cache WHERE key = ?").get(key) as { val: string; exp: number } | undefined;
    if (!row) return undefined;
    if (row.exp <= Date.now()) {
      stmt(db, "DELETE FROM cache WHERE key = ?").run(key);
      return undefined;
    }
    stmt(db, "UPDATE cache SET used = ? WHERE key = ?").run(Date.now(), key);
    return { exp: row.exp, val: JSON.parse(row.val) };
  } catch (e) {
    diskFailed("read", e);
    return undefined;
  }
}

let writes = 0;
function writeDisk(key: string, val: unknown, exp: number): void {
  try {
    const json = JSON.stringify(val);
    if (json === undefined || json.length > MAX_VALUE_BYTES) return;
    const db = getDb();
    const now = Date.now();
    stmt(db, "INSERT OR REPLACE INTO cache (key, val, exp, used) VALUES (?, ?, ?, ?)").run(key, json, exp, now);
    if (++writes % PRUNE_EVERY === 0) pruneDisk();
  } catch (e) {
    diskFailed("write", e);
  }
}

/** Drops expired rows, then the least recently used ones beyond MAX_ROWS. Returns the number of rows removed. */
export function pruneDisk(maxRows = MAX_ROWS): number {
  try {
    const db = getDb();
    let n = Number(stmt(db, "DELETE FROM cache WHERE exp <= ?").run(Date.now()).changes);
    n += Number(
      stmt(db, "DELETE FROM cache WHERE key IN (SELECT key FROM cache ORDER BY used DESC LIMIT -1 OFFSET ?)").run(maxRows).changes,
    );
    return n;
  } catch (e) {
    diskFailed("prune", e);
    return 0;
  }
}

function put(key: string, val: unknown, ttlMs: number, persist: boolean): void {
  store.delete(key);
  const exp = Date.now() + ttlMs;
  store.set(key, { exp, val });
  if (persist && !isEmpty(val)) writeDisk(key, val, exp);
  if (store.size > MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, e] of store) if (e.exp <= now) store.delete(k);
    while (store.size > MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest === undefined) break;
      store.delete(oldest);
    }
  }
}

/**
 * TTL cache with LRU eviction, in-flight de-duplication, and no caching of failures.
 * With `persist` (JSON-safe metadata that stays valid for minutes or longer; never stream URLs) entries are also
 * written through to SQLite and loaded lazily after a restart.
 */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, persist = false): Promise<T> {
  let hit = store.get(key);
  if (!hit && persist) {
    hit = readDisk(key);
    if (hit) noteRestored();
  }
  if (hit && hit.exp > Date.now()) {
    store.delete(key); // refresh LRU position
    store.set(key, hit);
    if (store.size > MAX_ENTRIES) put(key, hit.val, hit.exp - Date.now(), false);
    return Promise.resolve(hit.val as T);
  }
  const inflight = pending.get(key);
  if (inflight) return inflight as Promise<T>;
  const p = (async () => fn())()
    .then((val) => {
      put(key, val, isEmpty(val) ? Math.min(ttlMs, NEGATIVE_TTL_MS) : ttlMs, persist);
      return val;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** Forgets the in-memory entries only (what a restart does); the persisted copies stay. */
export function clearCache(): void {
  store.clear();
  pending.clear();
}

export function cacheSize(): number {
  return store.size;
}
