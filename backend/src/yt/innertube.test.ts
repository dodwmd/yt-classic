import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNext } from "./innertube.ts";

const lockup = (id: string, type = "LOCKUP_CONTENT_TYPE_VIDEO") => ({
  lockupViewModel: {
    contentId: id, contentType: type,
    contentImage: { thumbnailViewModel: { overlays: [{ x: { text: "13:42" } }] } },
    metadata: { lockupMetadataViewModel: { title: { content: "T " + id }, metadata: { contentMetadataViewModel: { metadataRows: [{ metadataParts: [{ text: { content: "Chan" } }, { text: { content: "1.2M" } }, { text: { content: "2mo ago" } }] }] } } } },
  },
});

test("parseNext extracts videos, skips non-videos and dupes", () => {
  const json = { a: { b: [lockup("AAAAAAAAAAA"), lockup("AAAAAAAAAAA"), lockup("PL1", "LOCKUP_CONTENT_TYPE_PLAYLIST")] } };
  const items = parseNext(json);
  assert.equal(items.length, 1);
  assert.deepEqual([items[0].channelTitle, items[0].views, items[0].age, items[0].duration], ["Chan", "1.2M", "2mo ago", "13:42"]);
});
test("parseNext tolerates junk", () => assert.deepEqual(parseNext({ foo: null }), []));
