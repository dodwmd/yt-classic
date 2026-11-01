import { getDb, stmt } from "./db.ts";
import { envInt } from "./env.ts";

/**
 * Data API quota bookkeeping (UTC day; YouTube itself resets at midnight Pacific, so this is an estimate).
 * `units` counts every request made; `fallback` counts the daily-capped yt-dlp-search fallbacks (100 units each).
 * Persisted in the `meta` table (like status.ts), so a restart doesn't hand out a fresh daily fallback cap.
 */
const KEY = "quota.today";
let day = "";
let units = 0;
let fallbackUsed = 0;
let loaded = false;

function load(): void {
  if (loaded) return;
  loaded = true;
  try {
    const row = stmt(getDb(), "SELECT value FROM meta WHERE key = ?").get(KEY) as { value: string } | undefined;
    const o = row ? (JSON.parse(row.value) as { day?: unknown; units?: unknown; fallback?: unknown }) : null;
    if (o && typeof o.day === "string" && Number.isFinite(o.units) && Number.isFinite(o.fallback)) [day, units, fallbackUsed] = [o.day, Number(o.units), Number(o.fallback)];
  } catch (e) {
    console.error(`quota: could not load persisted counters: ${(e as Error).message}`);
  }
}

function persist(): void {
  try {
    stmt(getDb(), "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(KEY, JSON.stringify({ day, units, fallback: fallbackUsed }));
  } catch (e) {
    console.error(`quota: could not persist counters: ${(e as Error).message}`);
  }
}

function rollover(): void {
  load();
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) [day, units, fallbackUsed] = [today, 0, 0];
}

export function addUnits(n: number): void {
  rollover();
  units += n;
  persist();
}

export function unitsToday(): number {
  rollover();
  return units;
}

/** Takes one of today's search fallbacks; false when the cap (SEARCH_FALLBACK_MAX, default 20) is used up. */
export function fallbackAllowed(): boolean {
  rollover();
  const ok = fallbackUsed++ < envInt("SEARCH_FALLBACK_MAX", 20);
  persist();
  return ok;
}

export function fallbackRemaining(): number {
  rollover();
  return Math.max(0, envInt("SEARCH_FALLBACK_MAX", 20) - fallbackUsed);
}

/** Test seam: forget the in-memory counters so the next call reloads what was persisted (a simulated restart). */
export function resetQuotaForTests(): void {
  [day, units, fallbackUsed, loaded] = ["", 0, 0, false];
}
