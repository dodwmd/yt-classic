import { envInt } from "./env.ts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_TOKEN, YT_PLAYLIST_ID, channel, channelAbout, channelKind, channelPlaylists, channelVideos, ownedPlaylist, playlistVideos, tabChannel, video, videoFacts } from "./yt/api.ts";
import { parseChapters } from "./yt/chapters.ts";
import { VIDEO_ID, baseQualities, knownOffered, knownUnplayable, parseLang, requestedQuality, resolveUrls, streamLive, parseStart } from "./yt/dlp.ts";
import { QuotaError, tabRequestWait } from "./tabquota.ts";
import { commentRequestWait } from "./commentquota.ts";
import { THREAD_ID, commentReplies, commentsKnownOff, videoComments } from "./yt/comments.ts";
import { pingDb } from "./db.ts";
import { CHANNEL_ID, addSub, addSubs, listSubs, removeSub } from "./store.ts";
import { channelFeed, subscriptionFeed } from "./yt/rss.ts";
import { FEED_CAP, HOME_PAGE, MAX_FEED_PAGE, decodeCursor, feedPage, parseFilter } from "./feed.ts";
import { getPrefs, parsePrefs, setPrefs } from "./prefs.ts";
import { TV_MIN_SUBS, MAX_SEEN_PARAM, TvLimiter, parseSeen, pickNext } from "./tv.ts";
import { DURATIONS, MAX_QUERY, SORTS, search, searchChannels } from "./yt/search.ts";
import { clearSearches, listSearches, recordSearch, removeSearch } from "./searches.ts";
import { MAX_SUGGEST_QUERY, suggest } from "./suggest.ts";
import { relatedFor } from "./yt/related.ts";
import { statusPage, statusReport } from "./status.ts";
import { logSafe } from "./http.ts";
import { INFO, classifyError, errorBody, type ErrorCode } from "./errors.ts";
import { countError, countRequest, routeClass } from "./metrics.ts";
import { metricsText } from "./scrape.ts";
import { MAX_PAGE, newRowAllowed, MAX_SECONDS, MIN_START, clearHistory, continueWatching, getProgress, isKnown, listHistory, recordProgress, removeHistory, watchedAmong } from "./history.ts";
import { MAX_MEMBERSHIP, lookupAllowed, noteLookup, PLAYLIST_ID, addItem, canAdd, createPlaylist, deletePlaylist, getPlaylist, listItems, listPlaylists, membership, moveItem, refreshMeta, removeItem, renamePlaylist } from "./playlists.ts";
import { MAX_IMPORT_BYTES, decodeBody, exportCsv, exportOpml, importMessage, parseImport } from "./subsio.ts";
import { SESSION_SECONDS, accessToken, clientIp, cookieHeader, createGate, makeSession, safeEqual, safeNext, sessionKey } from "./auth.ts";

// Local development only: serve the static frontend from here. In containers nginx does this and the
// frontend directory is not part of the backend image, so these lookups simply find nothing.
const publicDir = fileURLToPath(new URL("../../frontend/public/", import.meta.url));
const PAGES: Record<string, string> = { "/": "index.html", "/results": "results.html", "/watch": "watch.html", "/history": "history.html", "/playlists": "playlists.html", "/subscriptions": "subscriptions.html", "/tv": "tv.html", "/login": "login.html" };
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
};

/** Test seam: replaced by the tests to reset the request limit. */
export let tvLimiter = new TvLimiter();
/** How long /api/video/:id/qualities waits for the resolve that tells it the video's tiers. */
const offerWaitMs = () => envInt("OFFER_WAIT_MS", 4000); // env only so tests need not wait 4 s

export function resetTvLimiter(): void {
  tvLimiter = new TvLimiter();
}

const CHANNEL_TABS = ["head", "playlists", "playlist", "shorts", "live", "about"];
const text = { "content-type": "text/plain; charset=utf-8" };

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

/** Browsers always send Origin on cross-site POSTs; curl and friends send neither header and are allowed. */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin) {
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
  const site = req.headers["sec-fetch-site"];
  return !site || site === "same-origin" || site === "none";
}

/** Optional DNS-rebinding guard: ALLOWED_HOSTS="192.168.1.153:8080,yt.home.example". */
function hostAllowed(req: IncomingMessage): boolean {
  const allowed = (process.env.ALLOWED_HOSTS ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  return !allowed.length || allowed.includes(req.headers.host ?? "");
}

/** A classified failure: the status comes from the code, the body is {error, code, retryable}. */
function classified(res: ServerResponse, code: ErrorCode, message?: string, retryAfter?: number): void {
  countError(code);
  const retry = retryAfter ? String(retryAfter) : code === "busy" ? "5" : code === "rate-limited" ? "60" : "";
  json(res, INFO[code].status, errorBody(code, message), retry ? { "retry-after": retry } : {});
}

const tooMany = (res: ServerResponse, secs: number) => json(res, 429, { error: "too many attempts" }, { "retry-after": String(secs) });
const secureRequest = (req: IncomingMessage) => req.headers["x-forwarded-proto"] === "https";
const unauthorized = (res: ServerResponse) => json(res, 401, { error: "unauthorized" }, { "www-authenticate": "Bearer" });

async function readText(req: IncomingMessage, max = 4096): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | null> {
  const raw = await readText(req);
  return raw === null ? null : new URLSearchParams(raw);
}

/** The submitted token from a JSON `{token}` or form body; null when the body is too large. */
async function readLogin(req: IncomingMessage): Promise<string | null> {
  const body = await readText(req);
  if (body === null) return null;
  if ((req.headers["content-type"] ?? "").includes("json")) {
    try {
      const t = (JSON.parse(body) as { token?: unknown } | null)?.token;
      return typeof t === "string" ? t : "";
    } catch {
      return "";
    }
  }
  return new URLSearchParams(body).get("token") ?? "";
}

/** Progress comes as a form (the web page) or JSON (Android); either way only id, position and finished are read. */
async function readProgress(req: IncomingMessage): Promise<{ id: string; position: number; finished: boolean } | null> {
  const raw = await readText(req);
  if (raw === null) return null;
  let get: (k: string) => unknown;
  if ((req.headers["content-type"] ?? "").includes("json")) {
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      o = undefined;
    }
    const obj = (o && typeof o === "object" ? o : {}) as Record<string, unknown>;
    get = (k) => obj[k];
  } else {
    const form = new URLSearchParams(raw);
    get = (k) => form.get(k);
  }
  const position = get("position");
  const fin = get("finished");
  return {
    id: typeof get("id") === "string" ? (get("id") as string) : "",
    position: typeof position === "number" || (typeof position === "string" && position.trim() !== "") ? Number(position) : NaN,
    finished: fin === true || fin === "1" || fin === "true",
  };
}

/** Small form or JSON bodies (string/number/boolean values only); null when too large. */
async function readParams(req: IncomingMessage): Promise<Record<string, string> | null> {
  const raw = await readText(req);
  if (raw === null) return null;
  const out: Record<string, string> = {};
  if ((req.headers["content-type"] ?? "").includes("json")) {
    let o: unknown;
    try {
      o = JSON.parse(raw);
    } catch {
      o = undefined;
    }
    for (const [k, v] of Object.entries(o && typeof o === "object" ? o : {})) if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = String(v);
  } else {
    for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
  }
  return out;
}

/** The raw request body, or null when it is larger than [max] (the rest is read and dropped so the client gets the 413). */
async function readBody(req: IncomingMessage, max: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= max) chunks.push(chunk as Buffer);
  }
  return size > max ? null : Buffer.concat(chunks);
}

async function serveFrontend(path: string, res: ServerResponse): Promise<boolean> {
  let file = PAGES[path];
  if (!file && path.startsWith("/channel/")) file = "channel.html";
  if (!file && path.startsWith("/static/")) file = normalize(path.slice("/static/".length));
  if (!file || file.startsWith("..") || !TYPES[extname(file)]) return false;
  const body = await readFile(join(publicDir, file)).catch(() => null);
  if (!body) return false;
  res.writeHead(200, { "content-type": TYPES[extname(file)], "cache-control": "no-cache" }).end(body);
  return true;
}

async function handle(req: IncomingMessage, res: ServerResponse, gate: ReturnType<typeof createGate>): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const param = (name: string) => url.searchParams.get(name) ?? "";

  if (path === "/healthz") {
    try {
      pingDb();
    } catch (e) {
      console.error(`healthz: ${(e as Error).message}`);
      return void res.writeHead(503, text).end("database unavailable");
    }
    return void res.writeHead(200, text).end("ok");
  }
  if (!hostAllowed(req)) return json(res, 421, { error: "unknown host" });

  // --- Optional shared access token. Checked before any route runs (and so before yt-dlp/ffmpeg are spawned). ---
  const secret = accessToken();
  const ip = clientIp(req);
  if (path === "/api/session") {
    const v = secret ? gate.authenticate(req, secret, ip) : "ok";
    if (typeof v === "number") return tooMany(res, v);
    return json(res, 200, { auth: secret ? "required" : "none", authenticated: v === "ok" });
  }
  if (path === "/api/login" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    if (!secret) return json(res, 200, { auth: "none", authenticated: true });
    // The login page's plain HTML form lands back on a page; scripts and curl get JSON and status codes.
    const html = (req.headers.accept ?? "").includes("text/html") && !(req.headers["content-type"] ?? "").includes("json");
    const next = safeNext(url.searchParams.get("next"));
    const back = (frag: string, headers: Record<string, string> = {}) =>
      void res.writeHead(303, { location: `/login${next === "/" ? "" : `?next=${encodeURIComponent(next)}`}#${frag}`, "cache-control": "no-store", ...headers }).end();
    const wait = gate.lockedFor(ip);
    if (wait) return html ? back("locked") : tooMany(res, wait);
    const given = await readLogin(req);
    if (given === null) return json(res, 413, { error: "body too large" });
    if (!safeEqual(given, secret)) {
      gate.noteFailure(ip);
      return html ? back("bad") : json(res, 401, { error: "invalid token" });
    }
    const cookie = { "set-cookie": cookieHeader(makeSession(sessionKey(secret)), SESSION_SECONDS, secureRequest(req)) };
    if (html) return void res.writeHead(303, { location: next, "cache-control": "no-store", ...cookie }).end();
    return json(res, 200, { auth: "required", authenticated: true }, cookie);
  }
  if (path === "/api/logout" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const clear = { "set-cookie": cookieHeader("", 0, secureRequest(req)) };
    // The footer's plain HTML form lands on the login page; scripts get JSON.
    if ((req.headers.accept ?? "").includes("text/html")) return void res.writeHead(303, { location: "/login", "cache-control": "no-store", ...clear }).end();
    return json(res, 200, { authenticated: false }, clear);
  }
  if (secret && (path.startsWith("/api/") || path.startsWith("/stream/"))) {
    const v = gate.authenticate(req, secret, ip);
    if (typeof v === "number") return tooMany(res, v);
    if (v !== "ok") return unauthorized(res);
  }

  if (path === "/api/status") return json(res, 200, await statusReport());
  if (path === "/api/metrics") return void res.writeHead(200, { "content-type": "text/plain; version=0.0.4; charset=utf-8", "cache-control": "no-store" }).end(metricsText());
  // Server-rendered, no JavaScript: the shipped JS is at its size budget, and this page is a plain readout.
  if (path === "/status" && req.method === "GET") {
    // A page, not an API call: with an access token set, send a visitor without a session to the login page.
    if (secret) {
      const v = gate.authenticate(req, secret, ip);
      if (typeof v === "number") return tooMany(res, v);
      if (v !== "ok") return void res.writeHead(303, { location: "/login?next=%2Fstatus", "cache-control": "no-store" }).end();
    }
    return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(statusPage(await statusReport()));
  }

  /** One page of the merged feed, filtered by the query (absent options fall back to the saved preferences). */
  const feedFor = async (subs: Awaited<ReturnType<typeof listSubs>>, limit: number, cursor: string) => {
    const prefs = getPrefs();
    const f = parseFilter(url.searchParams, prefs);
    if ("error" in f) return { error: f.error };
    const cur = cursor ? decodeCursor(cursor) : null;
    if (cursor && !cur) return { error: "bad before" };
    const all = await subscriptionFeed(f.channel ? subs.filter((s) => s.id === f.channel) : subs, FEED_CAP);
    return { prefs, page: await feedPage({ all, facts: videoFacts, watched: watchedAmong }, f, limit, cur) };
  };

  if (path === "/api/home") {
    const subs = await listSubs();
    const r = await feedFor(subs, HOME_PAGE, "");
    if ("error" in r) return json(res, 400, { error: r.error });
    return json(res, 200, { subs, feed: r.page.items, next: r.page.next, prefs: r.prefs, continue: continueWatching() });
  }

  if (path === "/api/feed" && req.method === "GET") {
    const limit = Number(param("limit") || HOME_PAGE);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FEED_PAGE) return json(res, 400, { error: "bad limit" });
    const r = await feedFor(await listSubs(), limit, param("before"));
    if ("error" in r) return json(res, 400, { error: r.error });
    return json(res, 200, r.page);
  }

  if (path === "/api/prefs") {
    if (req.method === "GET") return json(res, 200, getPrefs());
    if (req.method !== "POST") return json(res, 405, { error: "method not allowed" }, { allow: "GET, POST" });
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const p = await readParams(req);
    if (!p) return json(res, 413, { error: "body too large" });
    const parsed = parsePrefs(p);
    if ("error" in parsed) return json(res, 400, { error: parsed.error });
    return json(res, 200, setPrefs(parsed.update));
  }

  if (path === "/api/tv/status") {
    const have = (await listSubs()).length;
    return json(res, 200, { have, need: TV_MIN_SUBS, ok: have >= TV_MIN_SUBS });
  }

  // TV mode: stateless. The client says which channel just played and which videos it has seen lately.
  if (path === "/api/tv/next") {
    // A GET that makes the server look things up: refuse cross-site triggers (an <img> on another site) like the writes.
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" }, { allow: "GET" });
    const after = param("after");
    const seenRaw = param("seen");
    if (after && !CHANNEL_ID.test(after)) return json(res, 400, { error: "bad channel id" });
    if (seenRaw.length > MAX_SEEN_PARAM) return json(res, 400, { error: "seen list too long" });
    const wait = tvLimiter.take();
    if (wait) return json(res, 429, { error: "too many TV requests; slow down" }, { "retry-after": String(wait) });
    const subs = await listSubs();
    if (subs.length < TV_MIN_SUBS) {
      const more = TV_MIN_SUBS - subs.length;
      return json(res, 409, { error: `Subscribe to ${more} more channel${more === 1 ? "" : "s"} to turn on TV.`, code: "need-subscriptions", have: subs.length, need: TV_MIN_SUBS });
    }
    const gone = new AbortController();
    res.once("close", () => gone.abort()); // the viewer left: stop looking things up
    const v = await pickNext({ subs, after, seen: parseSeen(seenRaw), watched: watchedAmong, feed: channelFeed, video, rand: Math.random, signal: gone.signal });
    if (gone.signal.aborted) return;
    if (!v) return json(res, 404, { error: "Could not find anything playable right now.", code: "nothing-playable" });
    const { quality, codecs } = requestedQuality(url.searchParams);
    resolveUrls(v.id, quality, "", codecs).catch(() => {}); // prewarm so the stream starts without waiting for yt-dlp
    return json(res, 200, { video: v, channelId: v.channelId, quality, qualities: baseQualities(), lang: "", progress: getProgress(v.id) ?? undefined });
  }

  if (path === "/api/search/suggest") {
    // Like /api/tv/next: a GET that makes the server contact someone else, so a cross-site <img> must not trigger it.
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const q = param("q").trim();
    if (q.length > MAX_SUGGEST_QUERY) return json(res, 400, { error: "query too long" });
    const suggestions = await suggest(q, ip);
    if (!suggestions) return json(res, 429, { error: "too many suggestion requests; slow down" }, { "retry-after": "30" });
    return json(res, 200, { suggestions });
  }

  if (path === "/api/search") {
    // Searching spawns yt-dlp, may spend API quota and is remembered: refuse cross-site triggers, as for the writes.
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const q = param("q").trim();
    const token = param("pageToken");
    const type = param("type") || "video";
    const duration = param("duration") || "any";
    const sort = param("sort") || "relevance";
    if (!q) return json(res, 400, { error: "missing query" });
    if (q.length > MAX_QUERY || token.length > 200) return json(res, 400, { error: "query too long" });
    if (type !== "video" && type !== "channel") return json(res, 400, { error: "bad type" });
    if (!DURATIONS.includes(duration as never) || !SORTS.includes(sort as never)) return json(res, 400, { error: "bad filter" });
    let body;
    if (type === "channel") {
      const page = await searchChannels(q, token);
      const mine = new Set((await listSubs()).map((s) => s.id));
      body = { ...page, channels: page.channels.map((c) => ({ ...c, subscribed: mine.has(c.id) })) };
    } else {
      body = await search(q, token, { duration: duration as never, sort: sort as never });
    }
    const found = type === "channel" ? (body as { channels: unknown[] }).channels.length : (body as { items: unknown[] }).items.length;
    if (!token && found) {
      // A successful, non-empty first page only (paging is not a new search); a database problem never breaks a search.
      try {
        recordSearch(q);
      } catch (e) {
        console.error(`recording a search failed: ${(e as Error).message.split("\n")[0]}`);
      }
    }
    return json(res, 200, body);
  }

  if (path === "/api/searches" || path.startsWith("/api/searches/")) {
    if (req.method === "GET" && path === "/api/searches") return json(res, 200, { searches: listSearches() });
    if (req.method !== "DELETE") return json(res, 405, { error: "method not allowed" });
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    if (path === "/api/searches") return json(res, 200, { removed: clearSearches() });
    const id = path.slice("/api/searches/".length);
    if (!/^\d{1,12}$/.test(id)) return json(res, 400, { error: "bad id" });
    return json(res, 200, { removed: removeSearch(Number(id)) });
  }

  // Comments (read-only). Both routes share one daily unit budget and an hourly request cap (commentquota.ts); cached pages cost no units.
  const commentsRoute = /^\/api\/video\/([^/]+)\/comments$/.exec(path) ?? /^\/api\/comments\/([^/]+)\/replies$/.exec(path);
  if (commentsRoute && req.method === "GET") {
    const replies = path.startsWith("/api/comments/");
    if (replies ? !THREAD_ID.test(commentsRoute[1]) : !VIDEO_ID.test(commentsRoute[1])) return json(res, 400, { error: replies ? "bad comment id" : "bad video id" });
    const token = param("pageToken");
    if (token && !PAGE_TOKEN.test(token)) return json(res, 400, { error: "bad page token" });
    const order = param("order") || "top";
    if (order !== "top" && order !== "new") return json(res, 400, { error: "bad order" });
    if (!replies && commentsKnownOff(commentsRoute[1])) return classified(res, "comments-disabled"); // known: no hourly slot, no units
    const wait = commentRequestWait();
    if (wait) return classified(res, "rate-limited", "Too many comment requests this hour. Try again later.", wait);
    try {
      return json(res, 200, replies ? await commentReplies(commentsRoute[1], token) : await videoComments(commentsRoute[1], order, token));
    } catch (e) {
      if (e instanceof QuotaError) return classified(res, "rate-limited", e.message, e.retryAfter);
      throw e;
    }
  }

  const qualitiesRoute = /^\/api\/video\/([^/]+)\/qualities$/.exec(path);
  if (qualitiesRoute) {
    // Which tiers (and codecs) the video has. Shares the resolve that /api/video prewarmed, waiting for it up to 4 s.
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    if (req.method !== "GET") return json(res, 405, { error: "method not allowed" }, { allow: "GET" });
    const id = qualitiesRoute[1];
    if (!VIDEO_ID.test(id)) return json(res, 400, { error: "bad video id" });
    const { quality, codecs } = requestedQuality(url.searchParams);
    const known = knownOffered(id);
    if (!known && !knownUnplayable(id)) {
      let timer: NodeJS.Timeout | undefined;
      let leave = () => {};
      const stop = new Promise<void>((r) => (leave = r));
      res.once("close", leave); // the viewer left: stop waiting (the resolve itself is shared and carries on)
      await Promise.race([resolveUrls(id, quality, parseLang(url.searchParams.get("a")), codecs).catch(() => {}), stop, new Promise((r) => (timer = setTimeout(r, offerWaitMs())))]);
      clearTimeout(timer);
      if (res.destroyed) return;
    }
    const offered = known ?? knownOffered(id);
    return json(res, 200, { qualities: offered?.qualities ?? baseQualities(), codecs: offered?.codecs ?? {}, tiersKnown: !!offered });
  }

  if (path.startsWith("/api/video/")) {
    const id = path.slice("/api/video/".length);
    if (!VIDEO_ID.test(id)) return json(res, 400, { error: "bad video id" });
    const v = await video(id);
    if (!v) return classified(res, "removed", "Video not found: it may have been removed or made private.");
    const { quality, auto, codecs } = requestedQuality(url.searchParams);
    const a = url.searchParams.get("a");
    const lang = parseLang(a);
    resolveUrls(id, quality, lang, codecs).catch(() => {}); // prewarm so the stream starts without waiting for yt-dlp
    const offered = knownOffered(id); // only when an earlier resolve already learned them; GET /api/video/:id/qualities waits for the rest
    refreshMeta({ id: v.id, title: v.title, channelId: v.channelId, channelTitle: v.channelTitle, thumb: v.thumb, durationSeconds: v.durationSeconds ?? 0 });
    const related = await relatedFor(v);
    const progress = getProgress(id) ?? undefined; // omitted when nothing is known
    // Playability hint, only when something already says it can't be played (Data API metadata or a recent yt-dlp failure).
    const reason = v.unplayable ?? knownUnplayable(id);
    const hint = reason ? { playable: false, reason, message: INFO[reason].message } : {};
    const chapters = parseChapters(v.description, v.durationSeconds); // from the description we already have: no extra API cost
    return json(res, 200, { video: v, related, quality, auto, qualities: offered?.qualities ?? baseQualities(), codecs: offered?.codecs ?? {}, tiersKnown: !!offered, lang: a && lang === a ? a : "", progress, ...(chapters.length ? { chapters } : {}), ...hint });
  }

  if (path === "/api/history" && req.method === "GET") {
    const limit = Number(param("limit") || 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return json(res, 400, { error: "bad limit" });
    try {
      return json(res, 200, listHistory(limit, param("before")));
    } catch {
      return json(res, 400, { error: "bad before" });
    }
  }

  if (path === "/api/history/watched" && req.method === "GET") {
    return json(res, 200, { ids: watchedAmong(param("ids").slice(0, 2000).split(",")) });
  }

  if (path === "/api/progress" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const p = await readProgress(req);
    if (!p) return json(res, 413, { error: "body too large" });
    if (!VIDEO_ID.test(p.id)) return json(res, 400, { error: "bad video id" });
    if (!Number.isFinite(p.position) || p.position < 0) return json(res, 400, { error: "bad position" });
    p.position = Math.min(p.position, MAX_SECONDS);
    // Title, channel and duration come from the server's own metadata, never from the request. Only a video that
    // is not in the history yet (and has been watched for a meaningful time) needs a lookup.
    let meta = null;
    if (!isKnown(p.id) && (p.finished || p.position >= MIN_START)) {
      if (!newRowAllowed()) return json(res, 429, { error: "too many new history entries; try again later" }, { "retry-after": "600" });
      const v = await video(p.id);
      if (!v) return json(res, 404, { error: "video not found" });
      meta = { id: v.id, title: v.title, channelId: v.channelId, channelTitle: v.channelTitle, thumb: v.thumb, durationSeconds: v.durationSeconds ?? 0 };
    }
    const outcome = recordProgress(p.id, p.position, p.finished, meta);
    if (outcome === "limited") return json(res, 429, { error: "too many new history entries; try again later" }, { "retry-after": "600" });
    return json(res, 200, { recorded: outcome === "recorded" });
  }

  if (path === "/api/history/clear" && req.method === "POST") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    return json(res, 200, { removed: clearHistory() });
  }

  if (path.startsWith("/api/history/") && req.method === "DELETE") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const id = path.slice("/api/history/".length);
    if (!VIDEO_ID.test(id)) return json(res, 400, { error: "bad video id" });
    return json(res, 200, { removed: removeHistory(id) });
  }

  if (path === "/api/playlists/membership" && req.method === "GET") {
    return json(res, 200, membership(param("ids").slice(0, MAX_MEMBERSHIP * 12).split(",")));
  }

  if (path === "/api/playlists" || path.startsWith("/api/playlists/")) {
    const parts = path === "/api/playlists" ? [] : path.slice("/api/playlists/".length).split("/");
    const [pid, sub, vid] = parts;
    const write = req.method === "POST" || req.method === "DELETE";
    if (write && !sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const failure = (f: string) =>
      f === "invalid" ? json(res, 400, { error: "Names are 1 to 80 characters." })
      : f === "exists" ? json(res, 409, { error: "A playlist with that name already exists." })
      : f === "full" ? json(res, 409, { error: "Limit reached." })
      : f === "builtin" ? json(res, 403, { error: "Watch later cannot be renamed or deleted." })
      : json(res, 404, { error: "playlist not found" });

    if (!pid) {
      if (req.method === "GET") return json(res, 200, { playlists: listPlaylists() });
      if (req.method !== "POST") return json(res, 405, { error: "method not allowed" });
      const p = await readParams(req);
      if (!p) return json(res, 413, { error: "body too large" });
      const made = createPlaylist(p.name ?? "");
      return typeof made === "string" ? failure(made) : json(res, 200, { playlist: made });
    }
    if (!PLAYLIST_ID.test(pid)) return json(res, 400, { error: "bad playlist id" });
    const id = Number(pid);

    if (!sub) {
      if (req.method === "GET") {
        const limit = Number(param("limit") || 50);
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) return json(res, 400, { error: "bad limit" });
        const playlist = getPlaylist(id);
        if (!playlist) return failure("missing");
        try {
          return json(res, 200, { playlist, ...listItems(id, limit, param("before")) });
        } catch {
          return json(res, 400, { error: "bad before" });
        }
      }
      if (req.method === "DELETE") {
        const r = deletePlaylist(id);
        return r === "removed" ? json(res, 200, { removed: true }) : failure(r);
      }
    } else if (sub === "rename" && req.method === "POST" && !vid) {
      const p = await readParams(req);
      if (!p) return json(res, 413, { error: "body too large" });
      const r = renamePlaylist(id, p.name ?? "");
      return typeof r === "string" ? failure(r) : json(res, 200, { playlist: r });
    } else if (sub === "items" && req.method === "POST" && !vid) {
      const p = await readParams(req);
      if (!p) return json(res, 413, { error: "body too large" });
      const videoId = p.id ?? "";
      if (!VIDEO_ID.test(videoId)) return json(res, 400, { error: "bad video id" });
      const can = canAdd(id, videoId);
      if (can === "missing" || can === "full") return failure(can === "full" ? "full" : "missing");
      if (can === "present") return json(res, 200, { added: false, playlist: getPlaylist(id) });
      // Title, channel and duration come from the server's own lookup, never from the request. A failed lookup adds nothing.
      if (!lookupAllowed()) return json(res, 429, { error: "too many new Watch later lookups; try again later" }, { "retry-after": "600" });
      noteLookup();
      const v = await video(videoId);
      if (!v) return json(res, 404, { error: "video not found" });
      const r = addItem(id, { id: v.id, title: v.title, channelId: v.channelId, channelTitle: v.channelTitle, thumb: v.thumb, durationSeconds: v.durationSeconds ?? 0 });
      if (r === "full" || r === "missing") return failure(r);
      return json(res, 200, { added: r === "added", playlist: getPlaylist(id) });
    } else if (sub === "items" && req.method === "DELETE" && vid && parts.length === 3) {
      if (!VIDEO_ID.test(vid)) return json(res, 400, { error: "bad video id" });
      if (!getPlaylist(id)) return failure("missing");
      return json(res, 200, { removed: removeItem(id, vid) });
    } else if (sub === "move" && req.method === "POST" && !vid) {
      const p = await readParams(req);
      if (!p) return json(res, 413, { error: "body too large" });
      const index = Number(p.index ?? "");
      if (!VIDEO_ID.test(p.id ?? "") || p.index === undefined || p.index.trim() === "" || !Number.isInteger(index) || index < 0 || index >= 100_000) return json(res, 400, { error: "bad move" });
      if (!getPlaylist(id)) return failure("missing");
      return moveItem(id, p.id!, index) ? json(res, 200, { moved: true }) : json(res, 404, { error: "video is not in this playlist" });
    }
    return json(res, 404, { error: "not found" });
  }

  if (path.startsWith("/api/channel/")) {
    const [id, tab, pid, ...extra] = path.slice("/api/channel/".length).split("/");
    if (!CHANNEL_ID.test(id)) return json(res, 400, { error: "bad channel id" });
    const token = param("pageToken");
    if (token && !PAGE_TOKEN.test(token)) return json(res, 400, { error: "bad page token" });
    if (tab !== undefined && (!CHANNEL_TABS.includes(tab) || extra.length || (tab === "playlist") !== (pid !== undefined))) return json(res, 404, { error: "not found" });
    if (tab === "playlist" && !YT_PLAYLIST_ID.test(pid)) return json(res, 400, { error: "bad playlist id" });
    try {
      if (tab !== undefined) {
        const wait = tabRequestWait();
        if (wait) return classified(res, "rate-limited", "Too many channel tab requests this hour. Try again later.", wait);
        const c = (await tabChannel(id)).channel; // an unknown channel is a clean 404, not an upstream error
        if (!c) return json(res, 404, { error: "channel not found" });
        if (tab === "head") return json(res, 200, { channel: c, subscribed: (await listSubs()).some((s) => s.id === id) });
        if (tab === "playlists") return json(res, 200, { page: await channelPlaylists(id, token) });
        if (tab === "playlist") {
          const pl = await ownedPlaylist(id, pid);
          if (!pl) return json(res, 404, { error: "playlist not found" });
          return json(res, 200, { playlist: pl, page: await playlistVideos(id, pid, token) });
        }
        if (tab === "shorts" || tab === "live") return json(res, 200, { page: await channelKind(id, tab, token) });
        const about = await channelAbout(id);
        return about ? json(res, 200, { about }) : json(res, 404, { error: "channel not found" });
      }
      const c = await channel(id); // resolve first so an unknown channel is a clean 404, not an upstream error
      if (!c) return json(res, 404, { error: "channel not found" });
      const [page, subs] = await Promise.all([channelVideos(id, token), listSubs()]);
      return json(res, 200, { channel: c, page, subscribed: subs.some((s) => s.id === id) });
    } catch (e) {
      if (e instanceof QuotaError) return classified(res, "rate-limited", e.message, e.retryAfter);
      throw e;
    }
  }

  if (req.method === "POST" && (path === "/api/subscribe" || path === "/api/unsubscribe")) {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const form = await readForm(req);
    if (!form) return json(res, 413, { error: "body too large" });
    const id = form.get("id") ?? "";
    if (!CHANNEL_ID.test(id)) return json(res, 400, { error: "bad channel id" });
    if (path === "/api/subscribe") {
      const c = await channel(id); // title comes from the API, not the request
      if (!c) return json(res, 404, { error: "channel not found" });
      if ((await addSub({ id, title: c.title })) === "full") return json(res, 409, { error: "subscription limit reached" });
      return json(res, 200, { subscribed: true });
    }
    await removeSub(id);
    return json(res, 200, { subscribed: false });
  }

  if (req.method === "POST" && path === "/api/subscriptions/import") {
    if (!sameOrigin(req)) return json(res, 403, { error: "cross-origin request refused" });
    const raw = await readBody(req, MAX_IMPORT_BYTES);
    if (raw === null) return json(res, 413, { error: "File too large (limit 1 MB)." });
    const body = decodeBody(raw);
    if (body === null) return json(res, 400, { error: "That file is not valid UTF-8 or UTF-16 text." });
    const parsed = parseImport(body);
    if (!parsed.subs.length && !parsed.invalid && !parsed.handles) {
      return json(res, 400, { error: "No subscriptions found. Use a Google Takeout subscriptions.csv, an OPML file, or a list of channel URLs." });
    }
    const { added, existing, full, total } = await addSubs(parsed.subs);
    const result = { added, existing, skipped: { invalid: parsed.invalid, handles: parsed.handles, full }, total };
    return json(res, 200, { ...result, message: importMessage(result) });
  }

  if (req.method === "GET" && path === "/api/subscriptions/export") {
    const format = url.searchParams.get("format") ?? "csv";
    if (format !== "csv" && format !== "opml") return json(res, 400, { error: "format must be csv or opml" });
    const subs = await listSubs();
    const body = format === "csv" ? exportCsv(subs) : exportOpml(subs);
    const type = format === "csv" ? "text/csv" : "text/x-opml";
    return void res
      .writeHead(200, {
        "content-type": `${type}; charset=utf-8`,
        "content-disposition": `attachment; filename="subscriptions.${format}"`,
        "cache-control": "no-store",
      })
      .end(body);
  }

  if (path.startsWith("/stream/")) {
    const id = path.slice("/stream/".length);
    if (!VIDEO_ID.test(id)) return void res.writeHead(400, text).end("bad video id");
    const { quality, codecs } = requestedQuality(url.searchParams);
    const lang = parseLang(url.searchParams.get("a"));
    if (url.searchParams.get("probe") === "1") {
      // The web player's way to learn why a stream failed: resolves exactly like a stream (a recent failure is reused)
      // and answers JSON, but never starts ffmpeg, takes a stream slot or counts as a stream.
      await resolveUrls(id, quality, lang, codecs);
      return json(res, 200, { ok: true });
    }
    return await streamLive(id, quality, lang, codecs, parseStart(url.searchParams.get("t")), req, res);
  }

  if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });
  if (req.method === "GET" && (await serveFrontend(path, res))) return;
  res.writeHead(404, text).end("not found");
}

/** Methods that may appear in the request log; anything else is logged as OTHER. */
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS"];

function fail(err: unknown, res: ServerResponse): void {
  console.error(logSafe(err instanceof Error ? (err.stack ?? err.message) : err, 4000)); // one line: error text can echo request data
  const code = classifyError(err);
  if (res.headersSent) return void (countError(code), res.destroy());
  // Operator-facing config problems are safe and useful to show; everything else is logged, not echoed.
  const msg = err instanceof Error && err.message.startsWith("YT_API_KEY") ? err.message : undefined;
  classified(res, code, msg);
}

export function createApp(): Server {
  const gate = createGate();
  const server = createServer((req, res) => {
    const t0 = Date.now();
    const path = (req.url ?? "").split("?")[0];
    res.once("close", () => {
      if (res.headersSent) countRequest(path, res.statusCode); // a client that left before any answer isn't a 2xx
      if (path !== "/healthz" && !path.startsWith("/static/")) console.log(`${METHODS.find((m) => m === req.method) ?? "OTHER"} ${routeClass(path)} ${res.statusCode} ${Date.now() - t0}ms`);
    });
    handle(req, res, gate).catch((err) => fail(err, res));
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
}
