import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeBody, exportCsv, exportOpml, parseCsv, parseImport } from "./subsio.ts";

const uc = (n: number | string) => "UC" + String(n).padStart(22, "0");
const A = uc(1), B = uc(2), C = uc("a-_");

test("Takeout CSV: plain, BOM, CRLF, quoted commas and quotes, blank lines", () => {
  const csv = `﻿Channel ID,Channel URL,Channel title\r\n${A},http://www.youtube.com/channel/${A},Plain\r\n\r\n` +
    `${B},http://www.youtube.com/channel/${B},"Comma, and ""quotes"""\r\n${C},http://www.youtube.com/channel/${C},"Multi\nline"\r\n`;
  const p = parseImport(csv);
  assert.deepEqual(p.subs, [
    { id: A, title: "Plain" },
    { id: B, title: 'Comma, and "quotes"' },
    { id: C, title: "Multi line" },
  ]);
  assert.equal(p.invalid + p.handles, 0);
});

test("CSV columns are found by header name, in any order, with extra columns", () => {
  const p = parseImport(`Channel title,Extra,Channel URL,Channel ID\nT1,x,https://www.youtube.com/channel/${A},${A}\nT2,y,https://www.youtube.com/channel/${B},${B}`);
  assert.deepEqual(p.subs, [{ id: A, title: "T1" }, { id: B, title: "T2" }]);
});

test("CSV with only a URL column works; a bad id column falls back to the URL", () => {
  assert.deepEqual(parseImport(`Channel URL,Channel title\nhttps://www.youtube.com/channel/${A},T`).subs, [{ id: A, title: "T" }]);
  assert.deepEqual(parseImport(`Channel ID,Channel URL,Channel title\nbogus,https://www.youtube.com/channel/${A},T`).subs, [{ id: A, title: "T" }]);
});

test("CSV rows that are not channels are counted, not imported", () => {
  const p = parseImport(`Channel ID,Channel URL,Channel title\nnope,,X\n,https://www.youtube.com/@someone,Y\n${A},,Z`);
  assert.deepEqual(p.subs, [{ id: A, title: "Z" }]);
  assert.equal(p.invalid, 1);
  assert.equal(p.handles, 1);
});

test("OPML as YouTube exports it, with entities, single quotes, comments and folders", () => {
  const opml = `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.1"><body><outline text="YouTube Subscriptions" title="YouTube Subscriptions">
    <!-- <outline title="hidden" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${C}"/> -->
    <outline text="Tom &amp; Jerry &lt;b&gt; &quot;q&quot; &apos;s&apos; &#65;&#x42;" title="Tom &amp; Jerry" type="rss" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${A}" />
    <outline title='Single > quoted' text="ignored" xmlUrl='https://www.youtube.com/feeds/videos.xml?channel_id=${B}'></outline>
    <outline text="Only text" XMLURL="https://www.youtube.com/feeds/videos.xml?channel_id=${C}"/>
    <outline text="Playlist" xmlUrl="https://www.youtube.com/feeds/videos.xml?playlist_id=PL123"/>
  </outline></body></opml>`;
  const p = parseImport(opml);
  assert.deepEqual(p.subs, [{ id: A, title: "Tom & Jerry" }, { id: B, title: "Single > quoted" }, { id: C, title: "Only text" }]);
  assert.equal(p.invalid, 1);
});

test("OPML entities are decoded once and unknown or oversized ones are not expanded", () => {
  const o = (t: string) => `<opml><body><outline text="${t}" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${A}"/></body></opml>`;
  assert.equal(parseImport(o("&amp;lt;")).subs[0].title, "&lt;");
  assert.equal(parseImport(o("a&xxe;b")).subs[0].title, "a&xxe;b");
  assert.equal(parseImport(o("a&#1114112;b&#xD800;c")).subs[0].title, "abc");
  assert.equal(parseImport(`<!DOCTYPE x [<!ENTITY e "BOOM">]>${o("&e;")}`).subs[0].title, "&e;");
});

test("plain lists: channel URLs, bare ids, feed URLs, comments; handles and junk counted", () => {
  const p = parseImport([
    `https://www.youtube.com/channel/${A}`, `  ${B}  `, `youtube.com/channel/${C}/videos`, "", "# a comment",
    `https://www.youtube.com/feeds/videos.xml?channel_id=${uc(9)}`,
    "https://www.youtube.com/@handle", "@other", "https://www.youtube.com/c/Legacy", "https://www.youtube.com/user/old",
    "hello", "UCshort", `${A}x`,
  ].join("\r\n"));
  assert.deepEqual(p.subs.map((s) => s.id), [A, B, C, uc(9)]);
  assert.equal(p.subs[0].title, A); // no title in a list: the id stands in
  assert.equal(p.handles, 4);
  assert.equal(p.invalid, 3);
});

test("titles are capped at 200 characters and stripped of control characters", () => {
  const p = parseImport(`Channel ID,Channel URL,Channel title\n${A},,${"x".repeat(500)}\n${B},,"a\u0007b"`);
  assert.equal(p.subs[0].title.length, 200);
  assert.equal(p.subs[1].title, "a b");
});

test("empty or meaningless input yields nothing", () => {
  assert.deepEqual(parseImport(""), { subs: [], invalid: 0, handles: 0 });
  assert.deepEqual(parseImport("﻿\r\n  \r\n"), { subs: [], invalid: 0, handles: 0 });
  assert.equal(parseImport("<opml><body></body></opml>").subs.length, 0);
});

test("parseCsv handles quotes, embedded newlines and a final line without a newline", () => {
  assert.deepEqual(parseCsv('a,"b,""c"""\r\n"x\r\ny",z'), { rows: [["a", 'b,"c"'], ["x\r\ny", "z"]], lost: 0 });
});

test("exports have the expected shape", () => {
  const subs = [{ id: A, title: 'A, "B"' }, { id: B, title: "Tom & <Jerry>" }];
  assert.equal(exportCsv(subs), `Channel ID,Channel URL,Channel title\r\n${A},https://www.youtube.com/channel/${A},"A, ""B"""\r\n${B},https://www.youtube.com/channel/${B},Tom & <Jerry>\r\n`);
  const opml = exportOpml(subs);
  assert.match(opml, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<opml version="1.1">/);
  assert.ok(opml.includes(`text="Tom &amp; &lt;Jerry&gt;" title="Tom &amp; &lt;Jerry&gt;" type="rss" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${B}"`));
  assert.equal(exportCsv([]), "Channel ID,Channel URL,Channel title\r\n");
});

test("round trip: what we export is what we import, in both formats, with awkward titles", () => {
  const subs = [
    { id: A, title: 'Quote " and, comma' }, { id: B, title: "<&>'\"" }, { id: C, title: "日本語 émoji 🎬" }, { id: uc(4), title: "x".repeat(200) },
  ];
  for (const text of [exportCsv(subs), exportOpml(subs), "﻿" + exportCsv(subs).replace(/\r\n/g, "\n")]) {
    assert.deepEqual(parseImport(text), { subs, invalid: 0, handles: 0 });
  }
});

test("CSV: an unterminated quote loses the rest of the file, and says so instead of looking clean", () => {
  const head = "Channel ID,Channel URL,Channel title\n";
  const p = parseImport(`${head}${A},,One\n${B},,"Never closed\n${C},,Three\n${uc(4)},,Four\n`);
  assert.deepEqual(p.subs, [{ id: A, title: "One" }]);
  assert.equal(p.invalid, 3); // the broken row and the two rows it swallowed
  assert.equal(parseImport(`${head}${A},,"oops`).invalid, 1);
  // a quote in the middle of an unquoted field is just a character
  assert.deepEqual(parseImport(`${head}${A},,5" nails`).subs, [{ id: A, title: '5" nails' }]);
});

test("CSV: with duplicate header names the first column wins", () => {
  const p = parseImport(`Channel ID,Channel ID,Channel title\n${A},${B},T`);
  assert.deepEqual(p.subs, [{ id: A, title: "T" }]);
});

test("export defuses spreadsheet formulas and import undoes it (round trip is clean)", () => {
  const subs = [{ id: A, title: "=HYPERLINK(\"http://x\")" }, { id: B, title: "+1" }, { id: C, title: "-2" }, { id: uc(4), title: "@sum" }, { id: uc(5), title: "ok=fine" }];
  const csv = exportCsv(subs);
  for (const line of csv.split("\r\n").slice(1, 5)) assert.match(line.split(",").slice(2).join(",").replace(/^"/, ""), /^'[=+\-@]/);
  assert.ok(csv.includes(",ok=fine"));
  assert.deepEqual(parseImport(csv).subs, subs);
  assert.equal(parseImport(`Channel ID,Channel URL,Channel title\n${A},,'quoted`).subs[0].title, "'quoted"); // only formula escapes are undone
});

test("titles lose bidi and separator characters and are cut by code point", () => {
  const t = (title: string) => parseImport(`Channel ID,Channel URL,Channel title\n${A},,"${title}"`).subs[0].title;
  assert.equal(t("a\u202Eb\u200Fc\u2066d\u2069e\u2028f\u2029g\u200Eh"), "abcdefgh");
  assert.equal(exportOpml([{ id: A, title: "x\u202Ey" }]).includes("\u202E"), false);
  const emoji = t("\u{1F600}".repeat(300));
  assert.equal(Array.from(emoji).length, 200);
  assert.ok(!/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(emoji), "split surrogate pair");
  assert.equal(Array.from(t("x".repeat(199) + "\u{1F600}y")).length, 200);
});

test("decodeBody: UTF-8, UTF-8 with BOM, UTF-16 LE/BE with BOM; invalid bytes are refused, not replaced", () => {
  const csv = `Channel ID,Channel URL,Channel title\n${A},,Caf\u00e9`;
  assert.equal(decodeBody(Buffer.from(csv)), csv);
  assert.equal(decodeBody(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(csv)])), csv);
  const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]);
  assert.equal(decodeBody(le), csv);
  assert.deepEqual(parseImport(decodeBody(le)!).subs, [{ id: A, title: "Caf\u00e9" }]);
  const be = Buffer.from(le); be.swap16(); be[0] = 0xfe; be[1] = 0xff;
  assert.deepEqual(parseImport(decodeBody(be)!).subs, [{ id: A, title: "Caf\u00e9" }]);
  assert.equal(decodeBody(Buffer.from([0x43, 0x61, 0x66, 0xe9])), null); // Latin-1 "Caf\u00e9"
});

test("a CSV or list that merely mentions <outline is not treated as OPML", () => {
  const p = parseImport(`Channel ID,Channel URL,Channel title\n${A},,"<outline text=x>"`);
  assert.deepEqual(p.subs, [{ id: A, title: "<outline text=x>" }]);
  assert.deepEqual(parseImport(`${A}\n# <outline xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${B}">`).subs.map((s) => s.id), [A]);
});

// Hostile 1 MB bodies must parse quickly: the parser runs on the server's event loop. Absolute wall-clock limits are
// flaky on shared CI runners, so the main check is about growth: the same input at 256 KB and at 1 MB (4x the size)
// must take well under 16x the time (linear is about 4x, a quadratic scan about 16x), plus a generous absolute ceiling
// for the catastrophic case (the old regex took 33 s). Each size takes the best of 3 runs to shed scheduling noise.
const bestMs = (text: string) => {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    parseImport(text);
    best = Math.min(best, performance.now() - t0);
  }
  return best;
};
const sized = (unit: string, bytes: number) => unit.repeat(Math.ceil(bytes / unit.length)).slice(0, bytes);

for (const [name, unit] of [
  ["repeated '<outline '", "<outline "],
  ["repeated '<outline a=\"'", '<outline a="'],
  ["repeated '<outline a='", "<outline a='"],
  ["repeated '<!--'", "<!--"],
  ["repeated '<'", "<"],
  ["unterminated quotes", '"'],
  ["unterminated CSV quote", 'Channel ID,Channel URL,Channel title\n"a,b\n'],
  ["repeated 'UC'", "UC"],
  ["repeated 'channel_id=UC'", "channel_id=UC"],
  ["whitespace", " \t"],
  ["newlines", "\n"],
  ["repeated '&#'", "&#"],
  ["long attribute names", "<outline " + "a".repeat(8000) + " "],
  ["many outlines with long values", `<outline text="${"x".repeat(100)}" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${A}"/>`],
] as const) {
  test(`parse budget: 1 MB of ${name} scales linearly and finishes within 2 s`, () => {
    for (const prefix of ["", "<opml><body>", "Channel ID,Channel URL,Channel title\n"]) {
      const small = bestMs(prefix + sized(unit, 256 * 1024));
      const large = bestMs(prefix + sized(unit, 1024 * 1024));
      const what = `${name} (prefix ${JSON.stringify(prefix.slice(0, 8))}): 256 KB ${small.toFixed(1)} ms, 1 MB ${large.toFixed(1)} ms`;
      assert.ok(large < 2000, `${what}: over the 2 s ceiling`);
      assert.ok(large < 8 * small + 50, `${what}: more than 8x slower for 4x the input, looks super-linear`);
    }
  });
}

test("the growth check can fail: a deliberately quadratic scan is caught", () => {
  const quadratic = (t: string) => {
    let n = 0;
    for (let i = 0; i < t.length; i++) n += t.indexOf("\u0001", i) + 1; // rescans the whole tail each time
    return n;
  };
  const time = (size: number) => {
    const text = "x".repeat(size);
    const t0 = performance.now();
    quadratic(text);
    return performance.now() - t0;
  };
  const small = Math.min(time(64 * 1024), time(64 * 1024), time(64 * 1024));
  const large = Math.min(time(256 * 1024), time(256 * 1024), time(256 * 1024));
  assert.ok(large >= 8 * small + 50 || large > 2000, `quadratic control not detected: ${small.toFixed(1)} -> ${large.toFixed(1)} ms`);
});

test("OPML: more than the outline cap is cut off, malformed tags are skipped, later valid ones still found", () => {
  const good = `<outline text="G" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${A}"/>`;
  assert.deepEqual(parseImport(`<opml>${"<outline <outline ".repeat(10)}${good}<outline "unterminated`).subs.map((s) => s.id), [A]);
  const many = good.repeat(25_000);
  assert.ok(parseImport(`<opml>${many}`).subs.length <= 20_000);
});
