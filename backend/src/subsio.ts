// Import and export of subscriptions: Google Takeout subscriptions.csv, YouTube's OPML export, and plain lists of
// channel URLs or ids. Hand-written on purpose (no dependency): the formats are tiny, and nothing here expands
// XML entities beyond the five basic ones and numeric references.
import { capTitle, type Subscription } from "./store.ts";

export const MAX_IMPORT_BYTES = 1024 * 1024;

export interface Parsed {
  subs: Subscription[];
  /** Entries that are no channel id at all. */
  invalid: number;
  /** @handle, /c/ and /user/ URLs: resolving them needs the Data API, which an import must not spend. */
  handles: number;
}

type Found = { sub: Subscription } | "invalid" | "handles";

// Every scan below is linear in the input: this code parses up to 1 MB of hostile text on the event loop.
// (No nested quantifiers or lazy matches over the whole body; the regexes only run on short, bounded strings.)
const ID_IN_TEXT = /(?:^|[/=])(UC[\w-]{22})(?![\w-])/;
const HANDLE_LIKE = /(?:^|\/)@|\/(?:c|user)\//i;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
// Bidi controls and line/paragraph separators can make a title lie about what it says.
const FORMAT = /[\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const MAX_OUTLINES = 20_000;
const MAX_TAG = 8192;

const cleanTitle = (s: string): string => capTitle(s.slice(0, 4096).replace(CONTROL, " ").replace(FORMAT, "").trim());

/** Bytes to text: UTF-8 (with or without BOM) or UTF-16 with a BOM. Null when the bytes are neither. */
export function decodeBody(buf: Uint8Array): string | null {
  try {
    if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder("utf-16le", { fatal: true }).decode(buf);
    if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder("utf-16be", { fatal: true }).decode(buf);
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Decide what one reference (URL, feed URL or id) is. The title falls back to the id, which is all we know. */
function classify(ref: string, title: string): Found {
  const r = ref.trim();
  const id = ID_IN_TEXT.exec(r)?.[1];
  if (id && !r.includes("/@")) return { sub: { id, title: cleanTitle(title) || id } };
  return HANDLE_LIKE.test(r) ? "handles" : "invalid";
}

/**
 * RFC 4180 records: quoted fields may hold commas, doubled quotes and line breaks; CRLF or LF. A quote that is
 * never closed swallows the rest of the text; the lines it swallowed are reported in [lost], not parsed.
 */
export function parseCsv(text: string): { rows: string[][]; lost: number } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let breaks = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') {
        field += c;
        if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) breaks++;
      } else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row); // skip blank lines
      row = [];
    } else field += c;
  }
  if (quoted) return { rows, lost: Math.max(1, breaks + 1 - (/[\r\n]$/.test(field) ? 1 : 0)) };
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return { rows, lost: 0 };
}

const headerKey = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
// Spreadsheet programs run cells that start with these as formulas; the export defuses them with a leading quote.
const FORMULA_START = /^[=+\-@\t\r]/;
const FORMULA_ESCAPED = /^'(?=[=+\-@\t\r])/;

function fromCsv(text: string): Found[] | null {
  const { rows, lost } = parseCsv(text);
  const head = rows[0]?.map(headerKey) ?? [];
  const idCol = head.indexOf("channelid"); // with duplicate headers the first one wins
  const urlCol = head.indexOf("channelurl");
  const titleCol = head.indexOf("channeltitle");
  if (idCol < 0 && urlCol < 0) return null; // not a Takeout-style header
  const found = rows.slice(1).map((r): Found => {
    const title = (r[titleCol] ?? "").replace(FORMULA_ESCAPED, "");
    const byId = idCol >= 0 ? classify(r[idCol] ?? "", title) : "invalid";
    return typeof byId === "object" || urlCol < 0 ? byId : classify(r[urlCol] ?? "", title);
  });
  for (let i = 0; i < lost; i++) found.push("invalid");
  return found;
}

function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos));/g, (m, dec, hex, name) => {
    if (name) return named[name];
    const cp = dec ? Number(dec) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : "";
  });
}

/** The attributes of one tag body, scanned once left to right (names lower-cased, values entity-decoded). */
function attributes(body: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const n = body.length;
  let i = 0;
  while (i < n) {
    while (i < n && /\s|\//.test(body[i])) i++;
    const start = i;
    while (i < n && !/[\s=/]/.test(body[i])) i++;
    const name = body.slice(start, i).toLowerCase();
    while (i < n && /\s/.test(body[i])) i++;
    if (body[i] !== "=") continue;
    i++;
    while (i < n && /\s/.test(body[i])) i++;
    const q = body[i];
    if (q !== '"' && q !== "'") continue;
    const end = body.indexOf(q, i + 1);
    if (end < 0) break;
    if (name) attrs[name] ??= decodeEntities(body.slice(i + 1, end));
    i = end + 1;
  }
  return attrs;
}

/**
 * One pass over the text: skips comments, finds `<outline ...>` tags (a ">" inside a quoted value does not end the
 * tag), gives up on a tag that is unterminated, contains a stray "<" or is absurdly long, and stops for good at
 * an unterminated quote or comment. Every character is visited a bounded number of times.
 */
function fromOpml(text: string): Found[] {
  const out: Found[] = [];
  let i = text.indexOf("<");
  while (i >= 0 && out.length < MAX_OUTLINES) {
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) break;
      i = text.indexOf("<", end + 3);
      continue;
    }
    let next = i + 1;
    const after = text[i + 8];
    if (text.slice(i + 1, i + 8).toLowerCase() === "outline" && (after === undefined || /[\s/>]/.test(after))) {
      let k = i + 8;
      let closed = false;
      while (k < text.length && k - i <= MAX_TAG) {
        const c = text[k];
        if (c === ">") {
          closed = true;
          break;
        }
        if (c === "<") break;
        if (c === '"' || c === "'") {
          const end = text.indexOf(c, k + 1);
          if (end < 0) return out; // unterminated quote: nothing after it can be trusted
          k = end;
        }
        k++;
      }
      if (closed) {
        const attrs = attributes(text.slice(i + 8, k));
        if (attrs.xmlurl) out.push(classify(attrs.xmlurl, attrs.title || attrs.text || ""));
      }
      next = Math.max(next, k);
    }
    i = text.indexOf("<", next);
  }
  return out;
}

function fromLines(text: string): Found[] {
  return text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => classify(l, ""));
}

/** Detect the format and extract the subscriptions. Nothing is stored here. */
export function parseImport(input: string): Parsed {
  const text = input.replace(/^﻿/, "");
  let found: Found[] | null = null;
  const firstLine = text.slice(0, 2000).split(/\r\n|\r|\n/, 1)[0];
  if (text.trimStart().startsWith("<")) found = fromOpml(text); // an OPML file, not a list that merely mentions "<outline"
  else if (/channel[\s_]*(?:id|url)/i.test(firstLine)) found = fromCsv(text);
  found ??= fromLines(text);
  const parsed: Parsed = { subs: [], invalid: 0, handles: 0 };
  for (const f of found) {
    if (f === "invalid") parsed.invalid++;
    else if (f === "handles") parsed.handles++;
    else parsed.subs.push(f.sub);
  }
  return parsed;
}

const csvField = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
const csvTitle = (s: string) => csvField(FORMULA_START.test(s) ? `'${s}` : s);

/** The Takeout shape. */
export function exportCsv(subs: Subscription[]): string {
  const rows = subs.map((s) => [csvField(s.id), csvField(`https://www.youtube.com/channel/${s.id}`), csvTitle(s.title)].join(","));
  return ["Channel ID,Channel URL,Channel title", ...rows].join("\r\n") + "\r\n";
}

// XML 1.0 cannot carry most control characters even as references, so they are dropped.
const xmlEscape = (s: string) =>
  s.replace(CONTROL, "").replace(FORMAT, "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** OPML in the layout of YouTube's subscription_manager export. */
export function exportOpml(subs: Subscription[]): string {
  const outlines = subs.map((s) => {
    const t = xmlEscape(s.title);
    return `      <outline text="${t}" title="${t}" type="rss" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=${s.id}" />`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<opml version="1.1">',
    "  <body>",
    '    <outline text="YouTube Subscriptions" title="YouTube Subscriptions">',
    ...outlines,
    "    </outline>",
    "  </body>",
    "</opml>",
    "",
  ].join("\n");
}

