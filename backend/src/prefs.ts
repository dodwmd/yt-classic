import { getDb, stmt } from "./db.ts";

/** Feed preferences, kept on the server (meta table) so the web and Android clients share them. */
export interface FeedPrefs {
  hideWatched: boolean;
  shorts: "show" | "hide";
  live: "show" | "hide";
}

export const DEFAULT_PREFS: FeedPrefs = { hideWatched: false, shorts: "show", live: "show" };

const KEYS = ["hideWatched", "shorts", "live"] as const;
const showHide = (v: string) => v === "show" || v === "hide";
const VALID: Record<(typeof KEYS)[number], (v: string) => boolean> = {
  hideWatched: (v) => v === "0" || v === "1",
  shorts: showHide,
  live: showHide,
};

export function getPrefs(): FeedPrefs {
  const rows = stmt(getDb(), "SELECT key, value FROM meta WHERE key LIKE 'feed.%'").all() as { key: string; value: string }[];
  const m = new Map(rows.map((r) => [r.key.slice(5), r.value]));
  const pick = (k: (typeof KEYS)[number]) => (m.has(k) && VALID[k](m.get(k)!) ? m.get(k)! : undefined);
  return {
    hideWatched: pick("hideWatched") === "1",
    shorts: (pick("shorts") as FeedPrefs["shorts"] | undefined) ?? DEFAULT_PREFS.shorts,
    live: (pick("live") as FeedPrefs["live"] | undefined) ?? DEFAULT_PREFS.live,
  };
}

/** Normalises user input: booleans may be "1"/"0"/"true"/"false". Returns null for anything else. */
function norm(key: (typeof KEYS)[number], v: string): string | null {
  const s = key === "hideWatched" ? (v === "true" ? "1" : v === "false" ? "0" : v) : v;
  return VALID[key](s) ? s : null;
}

/** Validates a partial update: only whitelisted keys with valid values. Returns the error text, or the parsed update. */
export function parsePrefs(input: Record<string, string>): { error: string } | { update: Partial<Record<(typeof KEYS)[number], string>> } {
  const update: Partial<Record<(typeof KEYS)[number], string>> = {};
  for (const [k, v] of Object.entries(input)) {
    if (!(KEYS as readonly string[]).includes(k)) return { error: `unknown preference: ${k.slice(0, 40)}` };
    const key = k as (typeof KEYS)[number];
    const n = norm(key, v);
    if (n === null) return { error: `bad value for ${key}` };
    update[key] = n;
  }
  if (!Object.keys(update).length) return { error: "nothing to change" };
  return { update };
}

export function setPrefs(update: Partial<Record<(typeof KEYS)[number], string>>): FeedPrefs {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [k, v] of Object.entries(update)) stmt(db, "INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(`feed.${k}`, v);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return getPrefs();
}
