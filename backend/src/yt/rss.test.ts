import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFeed } from "./rss.ts";

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
