const MAX_ENTRIES = 500;
const NEGATIVE_TTL_MS = 60_000;

const store = new Map<string, { exp: number; val: unknown }>();
const pending = new Map<string, Promise<unknown>>();

// null / [] / empty result pages are usually a transient miss or breakage upstream, so they only live briefly.
const isEmpty = (v: unknown): boolean =>
  v == null ||
  (Array.isArray(v) && v.length === 0) ||
  (typeof v === "object" && Array.isArray((v as { items?: unknown }).items) && (v as { items: unknown[] }).items.length === 0);

function put(key: string, val: unknown, ttlMs: number): void {
  store.delete(key);
  store.set(key, { exp: Date.now() + ttlMs, val });
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

/** TTL cache with LRU eviction, in-flight de-duplication, and no caching of failures. */
export function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) {
    store.delete(key); // refresh LRU position
    store.set(key, hit);
    return Promise.resolve(hit.val as T);
  }
  const inflight = pending.get(key);
  if (inflight) return inflight as Promise<T>;
  const p = (async () => fn())()
    .then((val) => {
      put(key, val, isEmpty(val) ? Math.min(ttlMs, NEGATIVE_TTL_MS) : ttlMs);
      return val;
    })
    .finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

export function clearCache(): void {
  store.clear();
  pending.clear();
}

export function cacheSize(): number {
  return store.size;
}
