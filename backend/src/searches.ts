import { getDb, stmt } from "./db.ts";

/** Recent searches live in the user's own yt.db (same trust model as the watch history) and never leave the server. */
export interface RecentSearch {
  id: number;
  query: string;
  at: number;
}

export const MAX_SEARCHES = 50;
export const MAX_RECENT_QUERY = 200;

const keyOf = (q: string): string => q.trim().replace(/\s+/g, " ").toLowerCase();

/** Remembers a query: a repeat (ignoring case and spacing) moves to the top; only the newest MAX_SEARCHES are kept. */
export function recordSearch(query: string, now = Date.now(), max = MAX_SEARCHES): void {
  const text = query.trim().replace(/\s+/g, " ").slice(0, MAX_RECENT_QUERY);
  if (!text) return;
  const db = getDb();
  stmt(db, "INSERT INTO searches (query, key, at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET query = excluded.query, at = excluded.at").run(text, keyOf(text), now);
  stmt(db, "DELETE FROM searches WHERE id IN (SELECT id FROM searches ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?)").run(max);
}

export function listSearches(limit = MAX_SEARCHES): RecentSearch[] {
  return stmt(getDb(), "SELECT id, query, at FROM searches ORDER BY at DESC, id DESC LIMIT ?").all(Math.min(MAX_SEARCHES, Math.max(1, limit))) as unknown as RecentSearch[];
}

export function removeSearch(id: number): boolean {
  return Number(stmt(getDb(), "DELETE FROM searches WHERE id = ?").run(id).changes) > 0;
}

export function clearSearches(): number {
  return Number(stmt(getDb(), "DELETE FROM searches").run().changes);
}
