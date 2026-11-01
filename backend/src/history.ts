import { getDb, stmt } from "./db.ts";
import { MAX_TITLE } from "./store.ts";
import { VIDEO_ID } from "./yt/dlp.ts";

/** The watch history lives in the user's own yt.db and never leaves the server. One row per video. */
export interface HistoryItem {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  thumb: string;
  durationSeconds: number;
  position: number;
  completed: boolean;
  lastWatched: number;
  watchCount: number;
}
/** What the server knows about a video (from its own metadata cache, never from the client). */
export interface VideoMeta {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  thumb: string;
  durationSeconds: number;
}

export const MAX_HISTORY = 5000;
export const MIN_MOVE = 2; // seconds: smaller position changes are not worth a write
export const MIN_START = 5; // seconds: a shorter look does not create a history row, nor count as resumable
export const END_SLACK = 10; // watched to within this many seconds of the end counts as completed
export const MAX_THUMB = 300;
export const MAX_PAGE = 100;
export const MAX_SECONDS = 100 * 3600; // no video or position is longer than this; keeps garbage out of the table
export const MAX_NEW_PER_HOUR = 60; // new rows, globally: stray or hostile requests cannot evict real history
export const CONTINUE_LIMIT = 12;

const COLS = "id, title, channel_id AS channelId, channel_title AS channelTitle, thumb, duration AS durationSeconds, position, completed, last_watched AS lastWatched, watch_count AS watchCount";

const toItem = (r: Record<string, unknown>): HistoryItem => ({
  id: r.id as string,
  title: r.title as string,
  channelId: r.channelId as string,
  channelTitle: r.channelTitle as string,
  thumb: r.thumb as string,
  durationSeconds: r.durationSeconds as number,
  position: r.position as number,
  completed: r.completed === 1,
  lastWatched: r.lastWatched as number,
  watchCount: r.watchCount as number,
});

/** Does the server need to look the video up? Only for the first row: later updates reuse what is stored. */
export function isKnown(id: string): boolean {
  return !!stmt(getDb(), "SELECT 1 FROM history WHERE id = ?").get(id);
}

export type Recorded = "recorded" | "ignored" | "limited";

let newRows: number[] = []; // creation times (ms) within the last hour; in memory, so a restart resets it
/** Test seam. */
export function resetNewRowLimit(): void {
  newRows = [];
}
export function newRowAllowed(now = Date.now()): boolean {
  newRows = newRows.filter((t) => t > now - 3_600_000);
  return newRows.length < MAX_NEW_PER_HOUR;
}

/**
 * Records a playback position. `meta` is only used to create the row (pass null when isKnown(id)).
 * Completed means finished by the client or within END_SLACK seconds of the end. Updates that barely move the
 * position are ignored, as are plays shorter than MIN_START seconds (for a new row, or restarting a completed one).
 */
export function recordProgress(id: string, positionIn: number, finished: boolean, meta: VideoMeta | null, now = Date.now(), max = MAX_HISTORY): Recorded {
  if (!VIDEO_ID.test(id) || !Number.isFinite(positionIn)) throw new RangeError("invalid progress");
  const db = getDb();
  const old = stmt(db, `SELECT ${COLS} FROM history WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  const prev = old && toItem(old);
  if (!prev && !meta) return "ignored";
  const duration = prev ? prev.durationSeconds : Math.min(MAX_SECONDS, Math.max(0, Math.floor(meta!.durationSeconds) || 0));
  let position = Math.min(MAX_SECONDS, Math.max(0, Math.floor(positionIn)));
  if (duration > 0) position = Math.min(position, duration);
  if (finished && duration > 0) position = duration;
  if (!finished && position < MIN_START && (!prev || prev.completed)) return "ignored";
  const completed = finished || (duration > 0 && position >= duration - END_SLACK);
  if (prev && !finished && Math.abs(position - prev.position) < MIN_MOVE && completed === prev.completed) return "ignored";

  if (!prev && !newRowAllowed(now)) return "limited";
  if (prev) {
    const count = prev.watchCount + (completed && !prev.completed ? 1 : 0);
    stmt(db, "UPDATE history SET position = ?, completed = ?, last_watched = ?, watch_count = ? WHERE id = ?").run(position, completed ? 1 : 0, now, count, id);
  } else {
    const m = meta!;
    stmt(db, "INSERT INTO history (id, title, channel_id, channel_title, thumb, duration, position, last_watched, completed, watch_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      id, String(m.title).slice(0, MAX_TITLE), String(m.channelId).slice(0, 40), String(m.channelTitle).slice(0, MAX_TITLE),
      String(m.thumb).slice(0, MAX_THUMB), duration, position, now, completed ? 1 : 0, completed ? 1 : 0,
    );
    newRows.push(now);
    stmt(db, "DELETE FROM history WHERE id IN (SELECT id FROM history ORDER BY last_watched DESC, rowid DESC LIMIT -1 OFFSET ?)").run(max);
  }
  return "recorded";
}

export function getProgress(id: string): { position: number; completed: boolean } | null {
  const r = stmt(getDb(), "SELECT position, completed FROM history WHERE id = ?").get(id) as { position: number; completed: number } | undefined;
  return r ? { position: r.position, completed: r.completed === 1 } : null;
}

/** Cursor: "<last_watched>.<rowid>" of the last item of the previous page. Opaque to clients. */
const CURSOR = /^(\d{1,15})\.(\d{1,15})$/;

/** Most recent first, in pages. Rows with the same timestamp are ordered by rowid, so no page boundary skips any. */
export function listHistory(limit = 50, cursor = ""): { items: HistoryItem[]; next?: string } {
  const n = Math.min(MAX_PAGE, Math.max(1, Math.floor(limit) || 50));
  const m = cursor ? CURSOR.exec(cursor) : null;
  if (cursor && !m) throw new RangeError("bad cursor");
  const [t, r] = m ? [Number(m[1]), Number(m[2])] : [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
  const rows = stmt(getDb(), `SELECT ${COLS}, rowid AS rid FROM history WHERE last_watched < ? OR (last_watched = ? AND rowid < ?) ORDER BY last_watched DESC, rowid DESC LIMIT ?`).all(t, t, r, n) as Record<string, unknown>[];
  const last = rows[rows.length - 1];
  return { items: rows.map(toItem), next: rows.length === n ? `${last.lastWatched as number}.${last.rid as number}` : undefined };
}

/** Unfinished videos worth resuming, most recent first. */
export function continueWatching(limit = CONTINUE_LIMIT): HistoryItem[] {
  return stmt(getDb(), `SELECT ${COLS} FROM history WHERE completed = 0 AND position >= ? ORDER BY last_watched DESC, rowid DESC LIMIT ?`).all(MIN_START, limit).map(toItem);
}

/** Which of these ids have been watched to the end. Bounded input; unknown or malformed ids are dropped. */
export function watchedAmong(ids: string[]): string[] {
  const valid = [...new Set(ids.filter((i) => VIDEO_ID.test(i)))].slice(0, MAX_PAGE);
  if (!valid.length) return [];
  const sql = `SELECT id FROM history WHERE completed = 1 AND id IN (${valid.map(() => "?").join(",")})`;
  return (stmt(getDb(), sql).all(...valid) as { id: string }[]).map((r) => r.id);
}

export function removeHistory(id: string): boolean {
  return Number(stmt(getDb(), "DELETE FROM history WHERE id = ?").run(id).changes) > 0;
}

export function clearHistory(): number {
  return Number(stmt(getDb(), "DELETE FROM history").run().changes);
}
