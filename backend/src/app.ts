import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { layout } from "./views/layout.ts";
import { resultsPage } from "./views/results.ts";
import { channel, channelVideos, video } from "./yt/api.ts";
import { VIDEO_ID, parseLang, parseQuality, parseStart, resolveUrls, streamLive } from "./yt/dlp.ts";
import { CHANNEL_ID, addSub, listSubs, removeSub } from "./store.ts";
import { subscriptionFeed } from "./yt/rss.ts";
import { MAX_QUERY, search } from "./yt/search.ts";
import { relatedFor } from "./yt/related.ts";
import { recommendations } from "./recs.ts";
import { homePage } from "./views/home.ts";
import { channelPage } from "./views/channel.ts";
import { watchPage } from "./views/watch.ts";
import { BusyError } from "./limit.ts";

// Dev convenience only: in containers nginx serves /static/ itself.
const publicDir = fileURLToPath(new URL("../../frontend/public/", import.meta.url));
const STATIC: Record<string, { file: string; type: string }> = {
  "/static/classic.css": { file: "classic.css", type: "text/css" },
  "/static/player.js": { file: "player.js", type: "text/javascript" },
};

const html = { "content-type": "text/html; charset=utf-8" };
const text = { "content-type": "text/plain; charset=utf-8" };

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

const withDeadline = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

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

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/healthz") return void res.writeHead(200, text).end("ok");
  if (!hostAllowed(req)) return void res.writeHead(421, text).end("unknown host");

  if (path === "/") {
    const subs = await listSubs();
    const feed = await subscriptionFeed(subs);
    const recs = await withDeadline(recommendations(feed, subs).catch(() => []), 5000, []);
    return void res.writeHead(200, html).end(homePage(subs, feed, recs));
  }

  if (path.startsWith("/channel/")) {
    const id = path.slice("/channel/".length);
    if (!CHANNEL_ID.test(id)) return void res.writeHead(400, text).end("bad channel id");
    const token = url.searchParams.get("pageToken") ?? "";
    if (token.length > 200) return void res.writeHead(400, text).end("bad page token");
    const c = await channel(id); // resolve first so an unknown channel is a clean 404, not an upstream error
    if (!c) return void res.writeHead(404, text).end("channel not found");
    const [page, subs] = await Promise.all([channelVideos(id, token), listSubs()]);
    return void res.writeHead(200, html).end(channelPage(c, page, subs.some((s) => s.id === id)));
  }

  if (req.method === "POST" && (path === "/subscribe" || path === "/unsubscribe")) {
    if (!sameOrigin(req)) return void res.writeHead(403, text).end("cross-origin request refused");
    const form = await readForm(req);
    if (!form) return void res.writeHead(413, text).end("body too large");
    const id = form.get("id") ?? "";
    if (!CHANNEL_ID.test(id)) return void res.writeHead(400, text).end("bad channel id");
    if (path === "/subscribe") {
      const c = await channel(id); // title comes from the API, not the form
      if (!c) return void res.writeHead(404, text).end("channel not found");
      if ((await addSub({ id, title: c.title })) === "full") return void res.writeHead(409, text).end("subscription limit reached");
    } else await removeSub(id);
    return void res.writeHead(303, { location: `/channel/${id}` }).end();
  }

  if (path === "/results") {
    const q = url.searchParams.get("search_query")?.trim() ?? "";
    if (!q) return void res.writeHead(302, { location: "/" }).end();
    const token = url.searchParams.get("pageToken") ?? "";
    if (q.length > MAX_QUERY || token.length > 200) return void res.writeHead(400, text).end("query too long");
    return void res.writeHead(200, html).end(resultsPage(q, await search(q, token)));
  }

  if (path === "/watch") {
    const id = url.searchParams.get("v") ?? "";
    if (!VIDEO_ID.test(id)) return void res.writeHead(400, text).end("bad video id");
    const v = await video(id);
    if (!v) return void res.writeHead(404, text).end("video not found");
    const q = parseQuality(url.searchParams.get("q"));
    const t = parseStart(url.searchParams.get("t"));
    const a = url.searchParams.get("a");
    resolveUrls(id, q, parseLang(a)).catch(() => {}); // prewarm so the stream starts without waiting for yt-dlp
    return void res.writeHead(200, html).end(watchPage(v, await relatedFor(v), q, t, a));
  }

  if (path.startsWith("/stream/")) {
    const id = path.slice("/stream/".length);
    if (!VIDEO_ID.test(id)) return void res.writeHead(400, text).end("bad video id");
    return await streamLive(id, parseQuality(url.searchParams.get("q")), parseLang(url.searchParams.get("a")), parseStart(url.searchParams.get("t")), req, res);
  }

  const asset = STATIC[path];
  if (asset) {
    const body = await readFile(publicDir + asset.file).catch(() => null);
    if (body) return void res.writeHead(200, { "content-type": asset.type }).end(body);
  }
  res.writeHead(404, text).end("not found");
}

function fail(err: unknown, res: ServerResponse): void {
  console.error(err);
  if (res.headersSent) return void res.destroy();
  if (err instanceof BusyError) {
    return void res.writeHead(503, { ...html, "retry-after": "5" }).end(layout("Busy", "<p>The server is busy. Try again in a few seconds.</p>"));
  }
  // Operator-facing config problems are safe and useful to show; everything else is logged, not echoed.
  const msg = err instanceof Error && err.message.startsWith("YT_API_KEY") ? err.message : "Something went wrong talking to YouTube. Check the backend log.";
  res.writeHead(502, html).end(layout("Error", `<p>${msg.replace(/[<>&]/g, "")}</p>`));
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
