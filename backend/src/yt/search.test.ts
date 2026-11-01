import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSearch } from "./search.ts";

const entry = (i: number) => ({ id: String(i).padStart(11, "x"), title: "T" + i, channel_id: "UC1", channel: "C", duration: 213, view_count: 5 });

test("parseSearch maps fields and pages", () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(i));
  const p2 = parseSearch({ entries }, 2);
  assert.equal(p2.items.length, 20);
  assert.equal(p2.items[0].title, "T20");
  assert.equal(p2.items[0].durationSeconds, 213);
  assert.equal(p2.prevPageToken, "1");
  assert.equal(p2.nextPageToken, "3");
  assert.equal(parseSearch({ entries: entries.slice(0, 5) }, 1).nextPageToken, undefined);
});
