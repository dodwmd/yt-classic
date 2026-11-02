import { fetchT } from "./http.ts";

/**
 * Search suggestions come from YouTube's public suggest endpoint, fetched by the server (the browser or app never talks
 * to Google). Queries are held only in memory, briefly, and are never logged. Any failure yields no suggestions.
 */
export const MAX_SUGGEST_QUERY = 100;
export const MAX_SUGGESTIONS = 8;
const TTL = 5 * 60_000;
const TIMEOUT = 2_000;
const MAX_CACHED = 200;
const PER_MINUTE = 120; // everyone together
const PER_CLIENT = 30; // one client (IP)
const MAX_BODY = 64 * 1024;

const memo = new Map<string, { at: number; ttl: number; list: string[] }>();
let window: number[] = [];
const clients = new Map<string, number[]>();

/** Test seam. */
export function resetSuggest(): void {
  memo.clear();
  window = [];
  clients.clear();
}

/** The endpoint answers with JSONP: window.google.ac.h(["q",[["suggestion",0,[..]],...],{...}]). */
export function parseSuggest(body: string): string[] {
  const start = body.indexOf("(");
  const end = body.lastIndexOf(")");
  if (start < 0 || end <= start) return [];
  try {
    const data = JSON.parse(body.slice(start + 1, end));
    const rows: unknown = Array.isArray(data) ? data[1] : null;
    if (!Array.isArray(rows)) return [];
    const out: string[] = [];
    for (const r of rows) {
      const s = Array.isArray(r) ? r[0] : null;
      if (typeof s === "string" && s.trim() && s.length <= MAX_SUGGEST_QUERY * 2 && !out.includes(s)) out.push(s);
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Reads at most MAX_BODY bytes, and stops reading as soon as that is reached. */
async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  void reader.cancel().catch(() => {});
  return Buffer.concat(chunks).subarray(0, MAX_BODY).toString("utf8");
}

/** Suggestions for q, or null when this client (or everyone together) is asking too often. */
export async function suggest(q: string, client = "", now = Date.now()): Promise<string[] | null> {
  const key = q.trim().toLowerCase().slice(0, MAX_SUGGEST_QUERY);
  if (!key) return [];
  const hit = memo.get(key);
  if (hit && now - hit.at < hit.ttl) return hit.list;
  const mine = (clients.get(client) ?? []).filter((t) => t > now - 60_000);
  window = window.filter((t) => t > now - 60_000);
  if (mine.length >= PER_CLIENT || window.length >= PER_MINUTE) return null;
  mine.push(now);
  clients.delete(client);
  clients.set(client, mine);
  if (clients.size > 500) clients.delete(clients.keys().next().value!);
  window.push(now);
  let list: string[] = [];
  try {
    const url = `https://suggestqueries-clients6.youtube.com/complete/search?${new URLSearchParams({ client: "youtube", ds: "yt", q: key })}`;
    const res = await fetchT(url, { headers: { accept: "*/*" } }, TIMEOUT);
    if (res.ok) list = parseSuggest(await readCapped(res));
  } catch {
    // Offline, blocked or slow: no suggestions, and nothing worth logging (a log line would hold the query).
  }
  if (memo.size >= MAX_CACHED) memo.delete(memo.keys().next().value!);
  memo.set(key, { at: now, ttl: list.length ? TTL : 30_000, list }); // a failure is remembered only briefly
  return list;
}
