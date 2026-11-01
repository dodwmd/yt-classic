import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { layout } from "./views/layout.ts";
import { resultsPage } from "./views/results.ts";
import { channel, channelVideos, video } from "./yt/api.ts";
import { VIDEO_ID, parseLang, parseQuality, parseStart, resolveUrls, streamLive } from "./yt/dlp.ts";
import { CHANNEL_ID, addSub, listSubs, removeSub } from "./store.ts";
import { subscriptionFeed } from "./yt/rss.ts";
import { search } from "./yt/search.ts";
import { relatedFor } from "./yt/related.ts";
import { recommendations } from "./recs.ts";
import { homePage } from "./views/home.ts";
import { channelPage } from "./views/channel.ts";
import { watchPage } from "./views/watch.ts";

const port = Number(process.env.PORT ?? 3000);
// Dev convenience only: in containers nginx serves /static/ itself.
const publicDir = fileURLToPath(new URL("../../frontend/public/", import.meta.url));

// Dev only: nginx serves /static/ in the container.
const STATIC: Record<string, { file: string; type: string }> = {
  "/static/classic.css": { file: "classic.css", type: "text/css" },
  "/static/player.js": { file: "player.js", type: "text/javascript" },
};

const html = { "content-type": "text/html; charset=utf-8" };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (url.pathname === "/healthz") return void res.writeHead(200).end("ok");
    if (url.pathname === "/") {
      const subs = await listSubs();
      const feed = await subscriptionFeed(subs);
      const recs = await recommendations(feed, subs).catch((e) => (console.error(e.message), []));
      return void res.writeHead(200, html).end(homePage(subs, feed, recs));
    }
    if (url.pathname.startsWith("/channel/")) {
      const id = url.pathname.slice("/channel/".length);
      if (!CHANNEL_ID.test(id)) return void res.writeHead(400).end("bad channel id");
      const [c, page, subs] = await Promise.all([channel(id), channelVideos(id, url.searchParams.get("pageToken") ?? ""), listSubs()]);
      if (!c) return void res.writeHead(404).end("channel not found");
      return void res.writeHead(200, html).end(channelPage(c, page, subs.some((s) => s.id === id)));
    }
    if (req.method === "POST" && (url.pathname === "/subscribe" || url.pathname === "/unsubscribe")) {
      let raw = "";
      for await (const chunk of req) if ((raw += chunk).length > 4096) return void res.writeHead(413).end();
      const id = new URLSearchParams(raw).get("id") ?? "";
      if (!CHANNEL_ID.test(id)) return void res.writeHead(400).end("bad channel id");
      if (url.pathname === "/subscribe") {
        const c = await channel(id); // title comes from the API, not the form
        if (!c) return void res.writeHead(404).end("channel not found");
        await addSub({ id, title: c.title });
      } else await removeSub(id);
      return void res.writeHead(303, { location: `/channel/${id}` }).end();
    }
    if (url.pathname === "/results") {
      const q = url.searchParams.get("search_query")?.trim() ?? "";
      if (!q) return void res.writeHead(302, { location: "/" }).end();
      const page = await search(q, url.searchParams.get("pageToken") ?? "");
      return void res.writeHead(200, html).end(resultsPage(q, page));
    }
    if (url.pathname === "/watch") {
      const id = url.searchParams.get("v") ?? "";
      if (!VIDEO_ID.test(id)) return void res.writeHead(400).end("bad video id");
      const v = await video(id);
      if (!v) return void res.writeHead(404).end("video not found");
      const q = parseQuality(url.searchParams.get("q"));
      const t = parseStart(url.searchParams.get("t"));
      resolveUrls(id, q, parseLang(url.searchParams.get("a"))).catch(() => {}); // prewarm so the stream starts without waiting for yt-dlp
      return void res.writeHead(200, html).end(watchPage(v, await relatedFor(v), q, t, url.searchParams.get("a")));
    }
    if (url.pathname.startsWith("/stream/")) {
      const id = url.pathname.slice("/stream/".length);
      if (!VIDEO_ID.test(id)) return void res.writeHead(400).end("bad video id");
      return await streamLive(id, parseQuality(url.searchParams.get("q")), parseLang(url.searchParams.get("a")), parseStart(url.searchParams.get("t")), req, res);
    }
    const asset = STATIC[url.pathname];
    if (asset) {
      const body = await readFile(publicDir + asset.file).catch(() => null);
      if (body) return void res.writeHead(200, { "content-type": asset.type }).end(body);
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  } catch (err) {
    console.error(err);
    if (res.headersSent) return void res.destroy();
    res.writeHead(502, html).end(layout("Error", `<p>Upstream error: ${(err as Error).message.replace(/[<>&]/g, "")}</p>`));
  }
});

server.listen(port, () => console.log(`backend listening on :${port}`));

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
