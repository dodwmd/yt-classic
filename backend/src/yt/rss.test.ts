import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { channelFeed, parseFeed } from "./rss.ts";
import { clearCache } from "../cache.ts";
import { closeDb } from "../db.ts";

const xml = `<feed><yt:channelId>UCabc</yt:channelId><title>Chan</title>
<entry><id>yt:video:AAAAAAAAAAA</id><yt:videoId>AAAAAAAAAAA</yt:videoId><yt:channelId>UCabc</yt:channelId>
<title>Tom &amp; Jerry</title><author><name>Chan</name></author><published>2026-10-01T10:00:00+00:00</published><media:group><media:description>Hello &amp; bye</media:description><media:community><media:statistics views="1234"/></media:community></media:group></entry>
<entry><yt:videoId>BBBBBBBBBBB</yt:videoId><title>Two</title><author><name>Chan</name></author><published>2026-10-02T10:00:00+00:00</published></entry></feed>`;

test("parseFeed", () => {
  const items = parseFeed(xml);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, "Tom & Jerry");
  assert.equal(items[0].views, "1234");
  assert.equal(items[0].description, "Hello & bye");
  assert.equal(items[1].views, undefined);
  assert.equal(items[1].channelId, "UCabc");
  assert.equal(items[1].channelTitle, "Chan");
});

test("channelFeed falls back to the Data API when the RSS endpoint keeps failing", async () => {
  clearCache();
  const dir = mkdtempSync(join(tmpdir(), "yt-rss-"));
  process.env.DATA_DIR = dir; // the feed cache is persisted
  process.env.YT_API_KEY = "test-key";
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = input instanceof Request ? input.url : String(input);
    calls.push(u.includes("feeds/videos.xml") ? "rss" : "api");
    if (u.includes("feeds/videos.xml")) return new Response("nope", { status: 404 });
    const item = { snippet: { resourceId: { videoId: "AAAAAAAAAAA" }, title: "From API", description: "d", publishedAt: "2026-10-01T00:00:00Z", videoOwnerChannelTitle: "Chan", thumbnails: {} } };
    return new Response(JSON.stringify({ items: [item] }), { status: 200 });
  }) as typeof fetch;
  try {
    const items = await channelFeed("UC" + "b".repeat(22));
    assert.deepEqual(items.map((i) => i.title), ["From API"]);
    assert.equal(items[0].channelTitle, "Chan");
    assert.equal(calls.filter((c) => c === "rss").length, 3, "RSS is retried before falling back");
    assert.equal(calls.filter((c) => c === "api").length, 1);
  } finally {
    globalThis.fetch = realFetch;
    clearCache();
    closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
});
