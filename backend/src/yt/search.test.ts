import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, mock } from "node:test";
import { closeDb } from "../db.ts";
import { getDb } from "../db.ts";
import { fallbackRemaining, resetQuotaForTests, unitsToday } from "../quota.ts";
import { classifyError } from "../errors.ts";
import { BusyError } from "../limit.ts";
import { clearCache } from "../cache.ts";
import { parseSearch, search } from "./search.ts";
const NO_FILTER = { duration: "any", sort: "relevance" } as const;

test("Data API page tokens count against the daily cap", async () => {
  process.env.YT_API_KEY = "k";
  process.env.SEARCH_FALLBACK_MAX = "2";
  resetCap();
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => (calls++, new Response(JSON.stringify({ items: [] })))) as typeof fetch;
  try {
    const results = await Promise.allSettled([1, 2, 3, 4].map((i) => search(`cap-test-${i}`, "g:CAoQAA")));
    assert.equal(calls, 2);
    assert.equal(results.filter((r) => r.status === "rejected").length, 2);
  } finally {
    globalThis.fetch = realFetch;
    delete process.env.SEARCH_FALLBACK_MAX;
  }
});

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

// ---- filters, channels (fixtures are real yt-dlp output for the channel-filtered results page, trimmed) ----
import { readFileSync } from "node:fs";
import { cleanChannel, scrubbed, inBucket, parseChannelSearch, searchChannels, spParam } from "./search.ts";

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), "yt-srch-db-"));
after(() => {
  closeDb();
  rmSync(process.env.DATA_DIR!, { recursive: true, force: true });
});

/** A fresh daily allowance: forget what quota.ts persisted (a real reset would need a new day). */
function resetCap(): void {
  getDb().exec("DELETE FROM meta WHERE key = 'quota.today'");
  resetQuotaForTests();
}
const spent = () => Number(process.env.SEARCH_FALLBACK_MAX) - fallbackRemaining();

const fixture = JSON.parse(readFileSync(new URL("./fixtures/channel-search.json", import.meta.url), "utf8"));

test("spParam encodes YouTube's own filter parameter", () => {
  assert.equal(spParam("video"), "EgIQAQ%3D%3D");
  assert.equal(spParam("channel"), "EgIQAg%3D%3D");
  assert.equal(spParam("video", { duration: "short", sort: "relevance" }), "EgQQARgB");
  assert.equal(spParam("video", { duration: "medium", sort: "relevance" }), "EgQQARgD");
  assert.equal(spParam("video", { duration: "long", sort: "relevance" }), "EgQQARgC");
  assert.equal(spParam("video", { duration: "any", sort: "date" }), "CAISAhAB");
  assert.equal(spParam("video", { duration: "any", sort: "views" }), "CAMSAhAB");
  assert.equal(spParam("channel", { duration: "short", sort: "relevance" }), "EgIQAg%3D%3D", "duration never applies to channels");
});

test("duration buckets: short < 4 min, medium 4-20 min, long > 20 min", () => {
  assert.deepEqual([239, 240].map((s) => inBucket(s, "short")), [true, false]);
  assert.deepEqual([239, 240, 1200, 1201].map((s) => inBucket(s, "medium")), [false, true, true, false]);
  assert.deepEqual([1200, 1201].map((s) => inBucket(s, "long")), [false, true]);
  assert.equal(inBucket(5, "any"), true);
});

test("parseChannelSearch maps a real yt-dlp channel search", () => {
  const p = parseChannelSearch(fixture, 1);
  assert.equal(p.channels.length, 3);
  const [a] = p.channels;
  assert.equal(a.id, "UCHnyfMqiRRG1u-2MsSQLbXA");
  assert.equal(a.title, "Veritasium");
  assert.equal(a.handle, "@veritasium");
  assert.equal(a.subscribers, "21400000");
  assert.match(a.thumb, /^https:\/\/yt3\.ggpht\.com\/.*s176/, "protocol-relative url upgraded to https, largest size chosen");
  assert.match(a.description, /element of truth/);
  assert.equal(p.nextPageToken, undefined);
});

test("parseChannelSearch drops anything that is not a well-formed channel and pages like video search", () => {
  const good = (i: number) => ({ channel_id: "UC" + String(i).padStart(22, "a"), channel: "C" + i, thumbnails: [{ url: "https://x.example/t.jpg", width: 1 }] });
  const mixed = { entries: [{ id: "dQw4w9WgXcQ", title: "a video" }, { channel_id: "UC-short" }, { channel_id: "UC" + "a".repeat(22), channel: "x" }, null, { ...good(1), channel_id: "UC" + "a".repeat(22) }] };
  assert.equal(parseChannelSearch(mixed, 1).channels.length, 1, "bad ids dropped, duplicates merged");
  const many = { entries: Array.from({ length: 40 }, (_, i) => good(i)) };
  assert.equal(parseChannelSearch(many, 1).nextPageToken, "2");
  const p2 = parseChannelSearch(many, 2);
  assert.equal(p2.channels[0].title, "C20");
  assert.equal(p2.nextPageToken, "3");
});

test("cleanChannel only accepts https thumbnails and sane handles, subscriber counts and lengths", () => {
  const id = "UC" + "a".repeat(22);
  assert.equal(cleanChannel({ id, thumb: "http://x.example/a.jpg" })?.thumb, "");
  assert.equal(cleanChannel({ id, thumb: "javascript:alert(1)" })?.thumb, "");
  assert.equal(cleanChannel({ id, thumb: "//x.example/a.jpg" })?.thumb, "https://x.example/a.jpg");
  assert.equal(cleanChannel({ id, handle: "@<script>" })?.handle, undefined);
  assert.equal(cleanChannel({ id, subscribers: "lots" })?.subscribers, undefined);
  assert.equal(cleanChannel({ id, description: "d".repeat(5000) })?.description.length, 300);
  assert.equal(cleanChannel({ id: "UC../../etc" }), null);
  assert.equal(cleanChannel({ id: 5 }), null);
});

test("channel search falls back to the Data API behind the same cap, with its own cache key and a note", async () => {
  const prevBin = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = "/nonexistent/yt-dlp";
  process.env.YT_API_KEY = "k";
  process.env.SEARCH_FALLBACK_MAX = "1";
  resetCap();
  const realFetch = globalThis.fetch;
  const urls: string[] = [];
  const chan = "UC" + "b".repeat(22);
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = String(input instanceof Request ? input.url : input);
    urls.push(u);
    if (u.includes("/channels?")) return new Response(JSON.stringify({ items: [{ id: chan, snippet: { customUrl: "@bee" }, statistics: { subscriberCount: "42" } }] }));
    return new Response(JSON.stringify({ nextPageToken: "NEXT", items: [
      { id: { kind: "youtube#channel", channelId: chan }, snippet: { title: "Bee", description: "honey", thumbnails: { default: { url: "https://yt3.ggpht.com/d" }, medium: { url: "https://yt3.ggpht.com/m" } } } },
      { id: { kind: "youtube#channel", channelId: "bad" }, snippet: { title: "Evil" } },
    ] }));
  }) as typeof fetch;
  try {
    const p = await searchChannels("fallback-chan");
    assert.deepEqual(p.channels, [{ id: chan, title: "Bee", thumb: "https://yt3.ggpht.com/m", description: "honey", subscribers: "42", handle: "@bee" }]);
    assert.equal(p.nextPageToken, "g:NEXT");
    assert.match(p.notes?.[0] ?? "", /Data API/);
    const search = new URL(urls[0]);
    assert.equal(search.searchParams.get("type"), "channel");
    assert.equal(search.searchParams.get("part"), "snippet");
    await searchChannels("fallback-chan"); // cached: no new quota
    assert.equal(urls.length, 2);
    // the cap (1 a day) is spent: neither a new query nor a page token may call the API again
    await assert.rejects(searchChannels("another-chan"));
    await assert.rejects(searchChannels("fallback-chan", "g:NEXT"));
    assert.equal(urls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    delete process.env.SEARCH_FALLBACK_MAX;
  }
});

test("video search with filters falls back to plain results, filtered locally, with notes", async () => {
  const prevBin = process.env.YTDLP_BIN;
  const dir = mkdtempSync(join(tmpdir(), "yt-srch-"));
  const bin = join(dir, "yt-dlp");
  const entries = [["aaaaaaaaaaa", 100, 5], ["bbbbbbbbbbb", 500, 90], ["ccccccccccc", 3000, 40]].map(([id, duration, view_count]) => ({ id, title: id, duration, view_count }));
  // fails for the filtered results page, answers plain ytsearch
  writeFileSync(bin, `#!/bin/sh\ncase "$*" in *results?search_query*) echo boom >&2; exit 1;; esac\necho '${JSON.stringify({ entries })}'\n`);
  chmodSync(bin, 0o755);
  process.env.YTDLP_BIN = bin;
  try {
    const med = await search("fb-filter", "", { duration: "medium", sort: "relevance" });
    assert.deepEqual(med.items.map((i) => i.id), ["bbbbbbbbbbb"]);
    assert.match(med.notes?.join(" ") ?? "", /duration filter/);
    const views = await search("fb-filter", "", { duration: "any", sort: "views" });
    assert.deepEqual(views.items.map((i) => i.id), ["bbbbbbbbbbb", "ccccccccccc", "aaaaaaaaaaa"]);
    assert.match(views.notes?.join(" ") ?? "", /views/);
    const date = await search("fb-filter", "", { duration: "any", sort: "date" });
    assert.match(date.notes?.join(" ") ?? "", /date/);
    assert.equal((await search("fb-filter")).notes, undefined, "an unfiltered search carries no notes");
  } finally {
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("video search fallback passes the filters to the Data API", async () => {
  const prevBin = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = "/nonexistent/yt-dlp";
  process.env.YT_API_KEY = "k";
  process.env.SEARCH_FALLBACK_MAX = "5";
  resetCap();
  const realFetch = globalThis.fetch;
  const urls: URL[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => (urls.push(new URL(String(input instanceof Request ? input.url : input))), new Response(JSON.stringify({ items: [] })))) as typeof fetch;
  try {
    await search("api-filter", "", { duration: "long", sort: "date" });
    const s = urls.find((u) => u.pathname.endsWith("/search"))!;
    assert.equal(s.searchParams.get("videoDuration"), "long");
    assert.equal(s.searchParams.get("order"), "date");
    await search("api-filter2");
    const plain = urls.filter((u) => u.pathname.endsWith("/search"))[1];
    assert.equal(plain.searchParams.get("videoDuration"), null);
    assert.equal(plain.searchParams.get("order"), null);
  } finally {
    globalThis.fetch = realFetch;
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    delete process.env.SEARCH_FALLBACK_MAX;
  }
});

// A private (0700, unique) directory per fake binary; scratch files the tests need live inside it too.
const fakeBin = (body: string | ((dir: string) => string)) => {
  const dir = mkdtempSync(join(tmpdir(), "yt-fake-"));
  const bin = join(dir, "yt-dlp");
  writeFileSync(bin, `#!/bin/sh\n${typeof body === "function" ? body(dir) : body}\n`);
  chmodSync(bin, 0o755);
  return { dir, bin };
};

test("a failing yt-dlp is logged without the query, the command line or any URL", async () => {
  const secret = "my-very-private-search";
  const { dir, bin } = fakeBin(`echo "ERROR: [youtube:search] ${secret}: unable to download https://www.youtube.com/results?search_query=${secret}" >&2; exit 3`);
  const prevBin = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = bin;
  process.env.YT_API_KEY = "";
  const logged: string[] = [];
  const realErr = console.error;
  console.error = (...a: unknown[]) => void logged.push(a.join(" "));
  try {
    await assert.rejects(search(secret));
    await assert.rejects(search(secret, "", { duration: "short", sort: "date" }));
    await assert.rejects(searchChannels(secret));
  } finally {
    console.error = realErr;
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(logged.length >= 3, "failures are still logged");
  assert.ok(logged.every((l) => !l.includes(secret) && !/https?:|youtube\.com|ytsearch/.test(l)), logged.join("\n"));
  assert.ok(logged.some((l) => l.includes("(exit 3)")), logged.join("\n"));
});

test("scrubbed() keeps the classification and the exit code but never the command line or the query", () => {
  const e = Object.assign(new Error("Command failed: yt-dlp ytsearch20:secret\nERROR: secret"), { code: 1, stderr: "WARNING: x\nERROR: secret not found: https://www.youtube.com/results?search_query=secret\n" });
  const out = scrubbed(e, "secret");
  assert.match(out.message, /^yt-dlp search failed: unknown \(exit 1\) WARNING: x$/);
  const kept = String((out as Error & { stderr?: string }).stderr);
  assert.ok(!out.message.includes("secret") && !kept.includes("secret") && !kept.includes("http"));
  const net = scrubbed(Object.assign(new Error("Command failed: x"), { code: 1, stderr: "ERROR: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution>\n" }), "q");
  assert.equal(classifyError(net), "network", "the classifier still sees what yt-dlp said");
  const rl = scrubbed(Object.assign(new Error("Command failed: x"), { code: 1, stderr: "ERROR: HTTP Error 429: Too Many Requests\n" }), "q");
  assert.equal(classifyError(rl), "rate-limited");
  assert.match(scrubbed(Object.assign(new Error("m"), { killed: true, code: null }), "q").message, /\(timeout\)/);
  assert.match(scrubbed(Object.assign(new Error("spawn yt-dlp ENOENT secret"), { code: "ENOENT" }), "secret").message, /\(spawn\)/);
});

test("a busy server is not a broken yt-dlp: no Data API call, the caller gets BusyError", async () => {
  const { dir, bin } = fakeBin(`sleep 1; echo '{"entries":[]}'`);
  const prevBin = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = bin;
  process.env.YT_API_KEY = "k";
  process.env.SEARCH_FALLBACK_MAX = "50";
  resetCap();
  const realFetch = globalThis.fetch;
  let apiCalls = 0;
  globalThis.fetch = (async () => (apiCalls++, new Response("{}"))) as typeof fetch;
  try {
    const out = await Promise.allSettled(Array.from({ length: 14 }, (_, i) => search(`busy-${i}`, "", i % 2 ? { duration: "short", sort: "relevance" } : NO_FILTER)));
    const busy = out.filter((r) => r.status === "rejected" && r.reason instanceof BusyError).length;
    assert.ok(busy >= 6, `${busy} rejected as busy`);
    assert.equal(out.filter((r) => r.status === "rejected" && !(r.reason instanceof BusyError)).length, 0);
    assert.equal(apiCalls, 0, "busy never spends Data API quota");
    assert.equal(spent(), 0);
  } finally {
    globalThis.fetch = realFetch;
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    delete process.env.SEARCH_FALLBACK_MAX;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cap: only real API calls spend (a failed one once, a cache hit never); the count survives a restart; a channel search is 101 units", async () => {
  const prevBin = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = "/nonexistent/yt-dlp";
  process.env.YT_API_KEY = "k";
  process.env.SEARCH_FALLBACK_MAX = "5";
  resetCap();
  clearCache();
  const realFetch = globalThis.fetch;
  let fail = true;
  let calls = 0;
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls++;
    if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/channels")) return new Response(JSON.stringify({ items: [] }));
    return fail ? new Response("{}", { status: 500 }) : new Response(JSON.stringify({ items: [], nextPageToken: "T" }));
  }) as typeof fetch;
  try {
    await assert.rejects(search("cap-a", "g:X"));
    assert.equal(spent(), 1, "a failed call counts once");
    fail = false;
    await search("cap-a", "g:X");
    await search("cap-a", "g:X"); // served from the cache
    await search("cap-a", "g:X");
    assert.equal(calls, 2);
    assert.equal(spent(), 2);
    assert.equal(unitsToday(), 200, "two 100-unit searches");
    const before = unitsToday();
    await searchChannels("cap-chan", "g:Y"); // search.list (100) + channels.list statistics (1)
    assert.equal(unitsToday() - before, 100, "no ids came back, so no statistics lookup");
    closeDb(); // what a restart does
    resetQuotaForTests();
    assert.equal(spent(), 3, "still 3 after reopening the database");
  } finally {
    globalThis.fetch = realFetch;
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    delete process.env.SEARCH_FALLBACK_MAX;
  }
});

test("a channel search page 1 through the Data API costs 101 units", async () => {
  const prevBin = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = "/nonexistent/yt-dlp";
  process.env.YT_API_KEY = "k";
  process.env.SEARCH_FALLBACK_MAX = "5";
  resetCap();
  clearCache();
  const realFetch = globalThis.fetch;
  const chan = "UC" + "d".repeat(22);
  globalThis.fetch = (async (input: string | URL | Request) =>
    new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith("/channels")
      ? new Response(JSON.stringify({ items: [{ id: chan, snippet: {}, statistics: { subscriberCount: "1" } }] }))
      : new Response(JSON.stringify({ items: [{ id: { channelId: chan }, snippet: { title: "D" } }] }))) as typeof fetch;
  try {
    const before = unitsToday();
    assert.equal((await searchChannels("units-chan")).channels.length, 1);
    assert.equal(unitsToday() - before, 101);
  } finally {
    globalThis.fetch = realFetch;
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    delete process.env.SEARCH_FALLBACK_MAX;
  }
});

test("a degraded (locally filtered) page is kept for about a minute, not ten; a recovered page shows at once", async () => {
  const entries = [{ id: "bbbbbbbbbbb", title: "b", duration: 500, view_count: 1 }];
  const { dir, bin } = fakeBin((d) => `case "$*" in *results?search_query*) [ -f ${d}/flag ] || { echo boom >&2; exit 1; };; *) echo x >> ${d}/plain;; esac\necho '${JSON.stringify({ entries })}'`);
  const flag = join(dir, "flag");
  const plain = join(dir, "plain");
  const prevBin = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = bin;
  clearCache();
  mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const opts = { duration: "medium", sort: "relevance" } as const;
  const plainRuns = () => (existsSync(plain) ? readFileSync(plain, "utf8").trim().split("\n").length : 0);
  try {
    assert.ok((await search("degrade-me", "", opts)).notes?.length, "degraded at first");
    assert.ok((await search("degrade-me", "", opts)).notes?.length);
    assert.equal(plainRuns(), 1, "the degraded copy is reused within the minute");
    mock.timers.tick(61_000);
    await search("degrade-me", "", opts);
    assert.equal(plainRuns(), 2, "after a minute it is looked up again");
    writeFileSync(flag, "x"); // YouTube's filtered page works again
    assert.equal((await search("degrade-me", "", opts)).notes, undefined, "the real page takes over immediately");
    assert.equal((await search("degrade-me", "", opts)).notes, undefined);
  } finally {
    mock.timers.reset();
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hostile queries are one argument each and cannot add options or filters", async () => {
  const { dir, bin } = fakeBin((d) => `printf '%s\\0' "$@" >> ${d}/argv; printf 'END\\0' >> ${d}/argv\necho '{"entries":[]}'`);
  const log = join(dir, "argv");
  const prevBin = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = bin;
  clearCache();
  const queries = ["--exec=touch /tmp/pwned", "-J", "a&sp=EgIQAg%3D%3D", "line1\nline2 --playlist-end 9999", "x#frag?y=z"];
  try {
    for (const q of queries) {
      await search(q);
      await search(q, "", { duration: "long", sort: "views" });
      await searchChannels(q);
    }
    const runs = readFileSync(log, "utf8").split("END\0").filter(Boolean).map((r) => r.split("\0").filter((x) => x !== ""));
    assert.equal(runs.length, queries.length * 3);
    for (const argv of runs) {
      assert.equal(argv.length, 6, JSON.stringify(argv)); // --flat-playlist --no-warnings --playlist-end N -J URL
      assert.deepEqual([argv[0], argv[1], argv[2], argv[4]], ["--flat-playlist", "--no-warnings", "--playlist-end", "-J"]);
      assert.match(argv[3], /^\d+$/);
      assert.ok(/^(ytsearch\d+:|https:\/\/www\.youtube\.com\/results\?search_query=)/.test(argv[5]), argv[5]);
      if (argv[5].startsWith("https:")) {
        const u = new URL(argv[5]);
        assert.deepEqual([...u.searchParams.keys()], ["search_query", "sp"], "the query cannot add parameters");
        assert.ok(!/[\n\r ]/.test(argv[5]));
      }
    }
    const first = runs[0][5];
    assert.equal(first, "ytsearch20:--exec=touch /tmp/pwned");
  } finally {
    if (prevBin === undefined) delete process.env.YTDLP_BIN;
    else process.env.YTDLP_BIN = prevBin;
    rmSync(dir, { recursive: true, force: true });
  }
});
