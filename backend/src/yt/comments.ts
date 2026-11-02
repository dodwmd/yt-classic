import { cached, isCached } from "../cache.ts";
import { spendComments } from "../commentquota.ts";
import { UpstreamError } from "../errors.ts";
import { call } from "./api.ts";

/** Read-only comments from the Data API (commentThreads.list / comments.list: 1 quota unit a page, no key ever leaves this file). */

export interface Comment {
  id: string;
  author: string;
  authorChannelId?: string;
  authorThumb?: string;
  text: string;
  likeCount: number;
  publishedAt: string;
  updatedAt?: string;
  replyCount: number;
}
export interface CommentPage {
  items: Comment[];
  nextPageToken?: string;
}

export const COMMENT_PAGE = 20;
export const MAX_TEXT = 5000;
export const MAX_AUTHOR = 100;
/** A thread id (also the parentId of replies): Data API ids look like "UgxAbC...", never contain a dot. */
export const THREAD_ID = /^[\w-]{16,80}$/;
/** A reply id is "<thread id>.<suffix>". */
const REPLY_ID = /^[\w-]{16,80}\.[\w-]{1,80}$/;
const CHANNEL_ID = /^UC[\w-]{22}$/;
const TEN_MIN = 10 * 60_000;

/**
 * Newline and tab are kept. Dropped: other control characters; bidi overrides and isolates (they can reorder the page around
 * a comment); zero-width space, the direction marks, the Arabic letter mark, the BOM and the tag characters (invisible text,
 * used to spoof names). The zero-width joiner and non-joiner stay: emoji sequences and several scripts need them.
 */
const printable = (cp: number) =>
  cp === 10 || cp === 9 ||
  (cp >= 32 && cp !== 127 && !(cp >= 0x80 && cp < 0xa0) && cp !== 0x200b && cp !== 0x200e && cp !== 0x200f && cp !== 0x061c && cp !== 0xfeff &&
    cp !== 0x2028 && cp !== 0x2029 && !(cp >= 0x202a && cp <= 0x202e) && !(cp >= 0x2066 && cp <= 0x2069) && !(cp >= 0xe0000 && cp <= 0xe007f));

const MAX_INPUT = 20_000;

/**
 * Comment text as shown. We ask the API for textFormat=plainText, so what comes back is already plain text: it is NOT
 * treated as HTML (no tag stripping, no entity decoding), so "a<b and c>d", a typed "<div>" or "&amp;" arrive as written.
 * Only control and invisible characters go, and the length is capped.
 */
export function plainText(s: unknown): string {
  if (typeof s !== "string") return "";
  let clean = "";
  for (const ch of s.slice(0, MAX_INPUT).replace(/\r\n?/g, "\n")) if (printable(ch.codePointAt(0)!)) clean += ch;
  return cap(clean, MAX_TEXT);
}

/** At most n UTF-16 units, never ending in half an emoji. */
const cap = (s: string, n: number) => (s.length > n ? s.slice(0, n).replace(/[\ud800-\udbff]$/, "") : s);
/** Avatars only from the hosts the page's CSP allows (https). */
const AVATAR_HOST = /^(?:yt3\.ggpht\.com|yt3\.googleusercontent\.com|[\w-]+\.ytimg\.com)$/;
function avatar(u: unknown): string | undefined {
  if (typeof u !== "string" || u.length > 500) return undefined;
  try {
    const x = new URL(u);
    return x.protocol === "https:" && !x.username && !x.password && !x.port && AVATAR_HOST.test(x.hostname) ? x.href : undefined;
  } catch {
    return undefined;
  }
}
const count = (n: unknown) => (typeof n === "number" && Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0);
const iso = (s: unknown) => (typeof s === "string" && Number.isFinite(Date.parse(s)) ? s : "");

/** One API comment resource to ours; null when its id is not one of YouTube's shapes (it is client-visible, so it is validated). */
function shape(c: any, replyCount: number, idOk: (id: string) => boolean): Comment | null {
  const sn = c?.snippet;
  if (typeof c?.id !== "string" || !idOk(c.id) || !sn) return null;
  const publishedAt = iso(sn.publishedAt);
  if (!publishedAt) return null;
  const channel = typeof sn.authorChannelId?.value === "string" && CHANNEL_ID.test(sn.authorChannelId.value) ? sn.authorChannelId.value : undefined;
  const updatedAt = iso(sn.updatedAt);
  return {
    id: c.id,
    author: cap(plainText(sn.authorDisplayName).replace(/\n/g, " "), MAX_AUTHOR),
    ...(channel ? { authorChannelId: channel } : {}),
    ...(avatar(sn.authorProfileImageUrl) ? { authorThumb: avatar(sn.authorProfileImageUrl) } : {}),
    text: plainText(sn.textOriginal ?? sn.textDisplay),
    likeCount: count(sn.likeCount),
    publishedAt,
    ...(updatedAt && updatedAt !== publishedAt ? { updatedAt } : {}),
    replyCount,
  };
}

const HOUR = 60 * 60_000;
const offKey = (videoId: string) => `commentsoff:${videoId}`;
/** True when we already learned (within the hour, also across restarts) that this video's comments are turned off. */
export const commentsKnownOff = (videoId: string): boolean => isCached(offKey(videoId));
const commentsOff = () => new UpstreamError("comments are disabled", 403, "commentsDisabled");

/** Cached page of a video's top-level comments. A video with comments off is remembered for an hour, for both orders and every page token. */
export async function videoComments(videoId: string, order: "top" | "new", pageToken = ""): Promise<CommentPage> {
  if (commentsKnownOff(videoId)) throw commentsOff();
  return cached<CommentPage>(`comments:${videoId}:${order}:${pageToken}`, TEN_MIN, async () => {
    spendComments(1);
    const params: Record<string, string> = { part: "snippet", videoId, maxResults: String(COMMENT_PAGE), order: order === "new" ? "time" : "relevance", textFormat: "plainText" };
    if (pageToken) params.pageToken = pageToken;
    try {
      const data = await call("commentThreads", params); // 1 unit
      const items: Comment[] = [];
      for (const t of data.items ?? []) {
        const c = shape(t?.snippet?.topLevelComment, count(t?.snippet?.totalReplyCount), (id) => THREAD_ID.test(id));
        if (c) items.push(c);
      }
      return { items, ...(typeof data.nextPageToken === "string" && /^[\w-]{1,120}$/.test(data.nextPageToken) ? { nextPageToken: data.nextPageToken } : {}) };
    } catch (e) {
      if (e instanceof UpstreamError && /^commentsdisabled$/i.test(e.reason)) {
        // A non-empty value, so it is kept for the full hour (an empty one would only live a minute) and on disk.
        await cached(offKey(videoId), HOUR, async () => ({ off: true }), true);
        throw commentsOff();
      }
      throw e;
    }
  }, !pageToken); // only first pages are kept on disk: minted tokens must not fill the database
}

/** Cached page of the replies to one thread (comments.list with parentId). */
export function commentReplies(parentId: string, pageToken = ""): Promise<CommentPage> {
  return cached(`replies:${parentId}:${pageToken}`, TEN_MIN, async () => {
    spendComments(1);
    const params: Record<string, string> = { part: "snippet", parentId, maxResults: String(COMMENT_PAGE), textFormat: "plainText" };
    if (pageToken) params.pageToken = pageToken;
    const data = await call("comments", params); // 1 unit
    const items: Comment[] = [];
    for (const c of data.items ?? []) {
      const x = shape(c, 0, (id) => REPLY_ID.test(id));
      if (x) items.push(x);
    }
    return { items, ...(typeof data.nextPageToken === "string" && /^[\w-]{1,120}$/.test(data.nextPageToken) ? { nextPageToken: data.nextPageToken } : {}) };
  }, !pageToken);
}
