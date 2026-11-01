import { getDb, stmt } from "./db.ts";
import { MAX_TITLE } from "./store.ts";
import { VIDEO_ID } from "./yt/dlp.ts";
import { MAX_THUMB, MAX_PAGE, MAX_SECONDS, type VideoMeta } from "./history.ts";

/** User-curated playlists in the user's own yt.db. Nothing here is generated or suggested. */
export interface Playlist {
  id: number;
  name: string;
  count: number;
  builtin: boolean;
}
export interface PlaylistItem {
  id: string;
  title: string;
  channelId: string;
  channelTitle: string;
  thumb: string;
  durationSeconds: number;
  added: number;
}

export const WATCH_LATER = 1;
export const MAX_PLAYLISTS = 50;
export const MAX_ITEMS = 500;
export const MAX_NAME = 80;
export const MAX_MEMBERSHIP = 100;

/** Playlist ids in URLs: plain decimal. */
export const PLAYLIST_ID = /^[1-9]\d{0,8}$/;

export type Failure = "invalid" | "exists" | "full" | "missing" | "builtin";

/** Trimmed, NFC, 1..80 code points, no control characters; null when unusable. */
export function cleanName(raw: string): string | null {
  const name = raw.normalize("NFC").trim();
  if (!name || Array.from(name).length > MAX_NAME || /[\p{Cc}\u2028\u2029]/u.test(name)) return null;
  return name;
}
const keyOf = (name: string) => name.toLowerCase();

/** Runs [fn] in one write transaction: the cap checks and the writes they guard cannot interleave with another process. */
function tx<T>(fn: () => T): T {
  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

const toPlaylist = (r: Record<string, unknown>): Playlist => ({ id: r.id as number, name: r.name as string, count: r.count as number, builtin: r.id === WATCH_LATER });

const LIST_SQL = "SELECT p.id AS id, p.name AS name, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS count FROM playlists p";

/** Watch later first, then the others in the order they were created. */
export function listPlaylists(): Playlist[] {
  return stmt(getDb(), `${LIST_SQL} ORDER BY p.id = ${WATCH_LATER} DESC, p.position, p.id`).all().map(toPlaylist);
}

export function getPlaylist(id: number): Playlist | null {
  const r = stmt(getDb(), `${LIST_SQL} WHERE p.id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? toPlaylist(r) : null;
}

export function createPlaylist(rawName: string, now = Date.now()): Playlist | Failure {
  const name = cleanName(rawName);
  if (!name) return "invalid";
  return tx(() => {
    const db = getDb();
    if ((stmt(db, "SELECT COUNT(*) AS n FROM playlists").get() as { n: number }).n >= MAX_PLAYLISTS) return "full";
    if (stmt(db, "SELECT 1 FROM playlists WHERE name_key = ?").get(keyOf(name))) return "exists";
    const pos = (stmt(db, "SELECT COALESCE(MAX(position), 0) + 1 AS p FROM playlists").get() as { p: number }).p;
    const r = stmt(db, "INSERT INTO playlists (name, name_key, created, updated, position) VALUES (?, ?, ?, ?, ?)").run(name, keyOf(name), now, now, pos);
    return { id: Number(r.lastInsertRowid), name, count: 0, builtin: false };
  });
}

export function renamePlaylist(id: number, rawName: string, now = Date.now()): Playlist | Failure {
  const name = cleanName(rawName);
  if (!name) return "invalid";
  if (id === WATCH_LATER) return "builtin";
  return tx(() => {
    const db = getDb();
    if (!getPlaylist(id)) return "missing";
    const clash = stmt(db, "SELECT id FROM playlists WHERE name_key = ?").get(keyOf(name)) as { id: number } | undefined;
    if (clash && clash.id !== id) return "exists";
    stmt(db, "UPDATE playlists SET name = ?, name_key = ?, updated = ? WHERE id = ?").run(name, keyOf(name), now, id);
    return getPlaylist(id)!;
  });
}

/** Items go with the playlist (foreign key cascade). */
export function deletePlaylist(id: number): "removed" | Failure {
  if (id === WATCH_LATER) return "builtin";
  return Number(stmt(getDb(), "DELETE FROM playlists WHERE id = ?").run(id).changes) > 0 ? "removed" : "missing";
}

export function hasItem(playlistId: number, videoId: string): boolean {
  return !!stmt(getDb(), "SELECT 1 FROM playlist_items WHERE playlist_id = ? AND video_id = ?").get(playlistId, videoId);
}

/** Cheap pre-check so the caller can refuse (or skip the metadata lookup) before spending an API unit. */
export function canAdd(playlistId: number, videoId: string): "ok" | "present" | "missing" | "full" {
  if (!getPlaylist(playlistId)) return "missing";
  if (hasItem(playlistId, videoId)) return "present";
  const n = (stmt(getDb(), "SELECT COUNT(*) AS n FROM playlist_items WHERE playlist_id = ?").get(playlistId) as { n: number }).n;
  return n >= MAX_ITEMS ? "full" : "ok";
}

/** Appends the video (metadata from the server's own lookup). Idempotent: a second add changes nothing. */
export function addItem(playlistId: number, meta: VideoMeta, now = Date.now()): "added" | "present" | "missing" | "full" | "invalid" {
  if (!VIDEO_ID.test(meta.id)) return "invalid";
  return tx(() => {
    const db = getDb();
    if (!getPlaylist(playlistId)) return "missing";
    if (hasItem(playlistId, meta.id)) return "present";
    const s = stmt(db, "SELECT COUNT(*) AS n, COALESCE(MAX(position), -1) AS top FROM playlist_items WHERE playlist_id = ?").get(playlistId) as { n: number; top: number };
    if (s.n >= MAX_ITEMS) return "full";
    const dur = Math.min(MAX_SECONDS, Math.max(0, Math.floor(meta.durationSeconds) || 0));
    stmt(db, "INSERT INTO playlist_items (playlist_id, video_id, added, position, title, channel_id, channel_title, thumb, duration) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      playlistId, meta.id, now, s.top + 1, String(meta.title).slice(0, MAX_TITLE), String(meta.channelId).slice(0, 40), String(meta.channelTitle).slice(0, MAX_TITLE), String(meta.thumb).slice(0, MAX_THUMB), dur,
    );
    stmt(db, "UPDATE playlists SET updated = ? WHERE id = ?").run(now, playlistId);
    return "added";
  });
}

export function removeItem(playlistId: number, videoId: string, now = Date.now()): boolean {
  const gone = Number(stmt(getDb(), "DELETE FROM playlist_items WHERE playlist_id = ? AND video_id = ?").run(playlistId, videoId).changes) > 0;
  if (gone) stmt(getDb(), "UPDATE playlists SET updated = ? WHERE id = ?").run(now, playlistId);
  return gone;
}

/** Moves the item to [index] (0-based, clamped to the end). Positions are renumbered, so they stay unique. */
export function moveItem(playlistId: number, videoId: string, index: number, now = Date.now()): boolean {
  return tx(() => {
    const db = getDb();
    const ids = (stmt(db, "SELECT video_id FROM playlist_items WHERE playlist_id = ? ORDER BY position, seq").all(playlistId) as { video_id: string }[]).map((r) => r.video_id);
    const from = ids.indexOf(videoId);
    if (from < 0) return false;
    ids.splice(from, 1);
    ids.splice(Math.min(Math.max(0, Math.floor(index)), ids.length), 0, videoId);
    const upd = stmt(db, "UPDATE playlist_items SET position = ? WHERE playlist_id = ? AND video_id = ?");
    ids.forEach((v, i) => upd.run(i, playlistId, v));
    stmt(db, "UPDATE playlists SET updated = ? WHERE id = ?").run(now, playlistId);
    return true;
  });
}

/** Lazily keeps the stored copy fresh: called whenever the server has just looked a video up anyway. */
export function refreshMeta(m: VideoMeta): void {
  if (!VIDEO_ID.test(m.id)) return;
  const dur = Math.min(MAX_SECONDS, Math.max(0, Math.floor(m.durationSeconds) || 0));
  stmt(getDb(), "UPDATE playlist_items SET title = ?, channel_id = ?, channel_title = ?, thumb = ?, duration = ? WHERE video_id = ? AND (title <> ? OR channel_title <> ? OR thumb <> ? OR duration <> ?)").run(
    String(m.title).slice(0, MAX_TITLE), String(m.channelId).slice(0, 40), String(m.channelTitle).slice(0, MAX_TITLE), String(m.thumb).slice(0, MAX_THUMB), dur, m.id,
    String(m.title).slice(0, MAX_TITLE), String(m.channelTitle).slice(0, MAX_TITLE), String(m.thumb).slice(0, MAX_THUMB), dur,
  );
}

/** Cursor: "<position>.<seq>" of the last item of the previous page (position may be negative). Opaque to clients. */
const CURSOR = /^(-?\d{1,15})\.(\d{1,15})$/;

export function listItems(playlistId: number, limit = 50, cursor = ""): { items: PlaylistItem[]; next?: string } {
  const n = Math.min(MAX_PAGE, Math.max(1, Math.floor(limit) || 50));
  const m = cursor ? CURSOR.exec(cursor) : null;
  if (cursor && !m) throw new RangeError("bad cursor");
  const [p, s] = m ? [Number(m[1]), Number(m[2])] : [-Number.MAX_SAFE_INTEGER, 0];
  const rows = stmt(getDb(), "SELECT video_id AS id, title, channel_id AS channelId, channel_title AS channelTitle, thumb, duration AS durationSeconds, added, position, seq FROM playlist_items WHERE playlist_id = ? AND (position > ? OR (position = ? AND seq > ?)) ORDER BY position, seq LIMIT ?").all(playlistId, p, p, s, n) as Record<string, unknown>[];
  const last = rows[rows.length - 1];
  return {
    items: rows.map((r) => ({ id: r.id as string, title: r.title as string, channelId: r.channelId as string, channelTitle: r.channelTitle as string, thumb: r.thumb as string, durationSeconds: r.durationSeconds as number, added: r.added as number })),
    next: rows.length === n ? `${last.position as number}.${last.seq as number}` : undefined,
  };
}

/** Which of these ids are in Watch later / in any playlist. Bounded; malformed ids are dropped. */
export function membership(ids: string[]): { watchLater: string[]; any: string[] } {
  const valid = [...new Set(ids.filter((i) => VIDEO_ID.test(i)))].slice(0, MAX_MEMBERSHIP);
  if (!valid.length) return { watchLater: [], any: [] };
  const rows = stmt(getDb(), `SELECT video_id AS id, MAX(playlist_id = ${WATCH_LATER}) AS wl FROM playlist_items WHERE video_id IN (${valid.map(() => "?").join(",")}) GROUP BY video_id`).all(...valid) as { id: string; wl: number }[];
  return { watchLater: rows.filter((r) => r.wl === 1).map((r) => r.id), any: rows.map((r) => r.id) };
}
