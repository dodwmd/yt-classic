import { readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getDb, onOpen, stmt } from "./db.ts";

export interface Subscription {
  id: string;
  title: string;
}

export const CHANNEL_ID = /^UC[\w-]{22}$/;
export const MAX_SUBS = 500;

const isSub = (s: unknown): s is Subscription =>
  !!s && typeof s === "object" && typeof (s as Subscription).id === "string" && typeof (s as Subscription).title === "string";

/**
 * One-time import of the pre-SQLite subscriptions.json. The file is renamed afterwards; a meta row records the
 * import too, so even if the rename fails a later unsubscribe is never undone by a second import.
 */
function importLegacyJson(db: DatabaseSync): void {
  const file = join(process.env.DATA_DIR ?? "./data", "subscriptions.json");
  const done = db.prepare("SELECT 1 FROM meta WHERE key = 'subscriptions_json_imported'").get();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") console.error(`cannot read ${file}: ${(e as Error).message}`);
    return;
  }
  const rename = (to: string, why: string) => {
    try {
      renameSync(file, to);
    } catch (e) {
      console.error(`could not rename ${file} (${why}): ${(e as Error).message}`);
    }
  };
  if (done) return rename(`${file}.migrated`, "already imported");
  let subs: Subscription[];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every(isSub)) throw new Error("not an array of {id, title}");
    subs = parsed;
  } catch (e) {
    // Don't take the whole site down over a damaged file: keep a copy for inspection and start empty.
    const bak = `${file}.corrupt-${Date.now()}`;
    console.error(`subscriptions.json is unreadable (${(e as Error).message}); moved to ${bak}`);
    return rename(bak, "corrupt");
  }
  const insert = db.prepare("INSERT OR IGNORE INTO subscriptions (id, title) VALUES (?, ?)");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const s of subs.slice(0, MAX_SUBS)) insert.run(s.id, s.title);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('subscriptions_json_imported', ?)").run(String(Date.now()));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  console.log(`imported ${Math.min(subs.length, MAX_SUBS)} subscriptions from ${file}`);
  rename(`${file}.migrated`, "imported");
}
onOpen(importLegacyJson);

export async function listSubs(): Promise<Subscription[]> {
  const rows = stmt(getDb(), "SELECT id, title FROM subscriptions ORDER BY seq").all() as unknown as Subscription[];
  return rows.map(({ id, title }) => ({ id, title })); // plain objects, not the driver's null-prototype rows
}

export async function addSub(sub: Subscription): Promise<"added" | "exists" | "full"> {
  const db = getDb();
  // Synchronous, so nothing can interleave with the count check; the transaction keeps it atomic across processes too.
  db.exec("BEGIN IMMEDIATE");
  try {
    let result: "added" | "exists" | "full";
    if (stmt(db, "SELECT 1 FROM subscriptions WHERE id = ?").get(sub.id)) result = "exists";
    else if ((stmt(db, "SELECT COUNT(*) AS n FROM subscriptions").get() as { n: number }).n >= MAX_SUBS) result = "full";
    else {
      stmt(db, "INSERT INTO subscriptions (id, title) VALUES (?, ?)").run(sub.id, sub.title);
      result = "added";
    }
    db.exec("COMMIT");
    return result;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export async function removeSub(id: string): Promise<void> {
  stmt(getDb(), "DELETE FROM subscriptions WHERE id = ?").run(id);
}
