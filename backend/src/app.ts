import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { channel, channelVideos, video } from "./yt/api.ts";
import { QUALITIES, VIDEO_ID, parseLang, parseQuality, resolveUrls, streamLive, parseStart } from "./yt/dlp.ts";
import { CHANNEL_ID, addSub, listSubs, removeSub } from "./store.ts";
import { subscriptionFeed } from "./yt/rss.ts";
import { MAX_QUERY, search } from "./yt/search.ts";
import { relatedFor } from "./yt/related.ts";
import { BusyError } from "./limit.ts";

// Local development only: serve the static frontend from here. In containers nginx does this and the
// frontend directory is not part of the backend image, so these lookups simply find nothing.
const publicDir = fileURLToPath(new URL("../../frontend/public/", import.meta.url));
const PAGES: Record<string, string> = { "/": "index.html", "/results": "results.html", "/watch": "watch.html" };
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
};

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

async function readForm(req: IncomingMessage, max = 4096): Promise<URLSearchParams | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;
  const param = (name: string) => url.searchParams.get(name) ?? "";

  if (path === "/healthz") return void res.writeHead(200, text).end("ok");
  if (!hostAllowed(req)) return json(res, 421, { error: "unknown host" });

  if (path === "/api/home") {
    const subs = await listSubs();
    const feed = await subscriptionFeed(subs);
    return json(res, 200, { subs, feed });
  }

  if (path === "/api/search") {
    const q = param("q").trim();
    const token = param("pageToken");
    if (!q) return json(res, 400, { error: "missing query" });
    if (q.length > MAX_QUERY || token.length > 200) return json(res, 400, { error: "query too long" });
    return json(res, 200, await search(q, token));
  }

  if (path.startsWith("/api/video/")) {
    const id = path.slice("/api/video/".length);
    if (!VIDEO_ID.test(id)) return json(res, 400, { error: "bad video id" });
    const v = await video(id);
    if (!v) return json(res, 404, { error: "video not found" });
    const quality = parseQuality(url.searchParams.get("q"));
    const a = url.searchParams.get("a");
    const lang = parseLang(a);
    resolveUrls(id, quality, lang).catch(() => {}); // prewarm so the stream starts without waiting for yt-dlp
    const related = await relatedFor(v);
    return json(res, 200, { video: v, related, quality, qualities: QUALITIES, lang: a && lang === a ? a : "" });
  }

  if (path.startsWith("/api/channel/")) {
    const id = path.slice("/api/channel/".length);
    if (!CHANNEL_ID.test(id)) return json(res, 400, { error: "bad channel id" });
    const token = param("pageToken");
    if (token.length > 200) return json(res, 400, { error: "bad page token" });
    const c = await channel(id); // resolve first so an unknown channel is a clean 404, not an upstream error
    if (!c) return json(res, 404, { error: "channel not found" });
    const [page, subs] = await Promise.all([channelVideos(id, token), listSubs()]);
    return json(res, 200, { channel: c, page, subscribed: subs.some((s) => s.id === id) });
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

  if (path.startsWith("/stream/")) {
    const id = path.slice("/stream/".length);
    if (!VIDEO_ID.test(id)) return void res.writeHead(400, text).end("bad video id");
    return await streamLive(id, parseQuality(url.searchParams.get("q")), parseLang(url.searchParams.get("a")), parseStart(url.searchParams.get("t")), req, res);
  }

  if (path.startsWith("/api/")) return json(res, 404, { error: "not found" });
  if (req.method === "GET" && (await serveFrontend(path, res))) return;
  res.writeHead(404, text).end("not found");
}

function fail(err: unknown, res: ServerResponse): void {
  console.error(err);
  if (res.headersSent) return void res.destroy();
  if (err instanceof BusyError) return json(res, 503, { error: "The server is busy. Try again in a few seconds." }, { "retry-after": "5" });
  // Operator-facing config problems are safe and useful to show; everything else is logged, not echoed.
  const msg = err instanceof Error && err.message.startsWith("YT_API_KEY") ? err.message : "Something went wrong talking to YouTube. Check the backend log.";
  json(res, 502, { error: msg });
}

export function createApp(): Server {
  const server = createServer((req, res) => {
    const t0 = Date.now();
    const path = (req.url ?? "").split("?")[0];
    if (path !== "/healthz" && !path.startsWith("/static/")) {
      res.once("close", () => console.log(`${req.method} ${path} ${res.statusCode} ${Date.now() - t0}ms`));
    }
    handle(req, res).catch((err) => fail(err, res));
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 30_000;
  return server;
}
