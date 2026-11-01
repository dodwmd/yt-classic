import { cacheStats } from "./cache.ts";
import { getDb, stmt } from "./db.ts";
import { renderMetrics } from "./metrics.ts";
import { fallbackRemaining, unitsToday } from "./quota.ts";

const started = Date.now();

/** Database size from SQLite's own page accounting; null when the database can't be reached (not 0, which would look healthy). */
export function dbBytes(): number | null {
  try {
    const db = getDb();
    const n = (sql: string) => Number((stmt(db, sql).get() as Record<string, number>).v);
    return n("SELECT page_count * page_size AS v FROM pragma_page_count, pragma_page_size");
  } catch {
    return null;
  }
}

/** The body of GET /api/metrics. */
export function metricsText(): string {
  const c = cacheStats();
  return renderMetrics({
    uptimeSeconds: Math.round((Date.now() - started) / 1000),
    cacheHits: c.hits,
    cacheMisses: c.misses,
    cacheEntries: c.entries,
    dbBytes: dbBytes(),
    dataApiUnitsToday: unitsToday(),
    searchFallbackRemaining: fallbackRemaining(),
  });
}
