/**
 * Chapters from a video description, by YouTube's rule: a list of timestamp lines that starts at 0:00, ascends
 * strictly and has at least three entries. Costs nothing extra (the description is already fetched) and every step
 * is linear: lines are split once, each line is matched by a short anchored pattern with bounded prefixes.
 * The same rule links timestamps in the clients (see the README, "Chapters and timestamps").
 */
export interface Chapter {
  start: number;
  end: number;
  title: string;
}

export const MIN_CHAPTERS = 3;
export const MAX_CHAPTERS = 100;
export const MAX_TITLE = 100;

// Up to 5 decorations (bullet, bracket, emoji, "-") before the time; h:mm:ss or m:ss; not followed by a digit, a further
// ":digit" or a letter (so "12:345", "1:02:03:04" and "10:00pm" are not timestamps; "1:02: Title" is).
const LINE = /^[^\p{L}\p{N}]{0,5}(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?!\d|:\d|\p{L})(.*)$/u;
// What separates a time from its title: spaces, dashes, closing brackets, bullets, colons, dots (emoji and opening brackets belong to the title).
const SEP = /^[\s\-\u2010-\u2015:|.)\]>~\u2022\u00b7]+/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\u061c\ufeff\ufff9-\ufffc]/g;

/** Seconds and title of a description line that starts with a timestamp, else null. */
export function timestampLine(line: string): { start: number; title: string } | null {
  const m = LINE.exec(line.length > 400 ? line.slice(0, 400) : line);
  if (!m) return null;
  const h = m[1] === undefined ? 0 : Number(m[1]), min = Number(m[2]), sec = Number(m[3]);
  if (sec > 59 || (m[1] !== undefined && min > 59)) return null;
  const title = Array.from(m[4].replace(SEP, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim()).slice(0, MAX_TITLE).join("").trim();
  if (!title) return null;
  return { start: h * 3600 + min * 60 + sec, title };
}

/** Chapters for a description and the video's duration in seconds; [] when the description has no valid list. */
export function parseChapters(description: string, durationSeconds: number | undefined): Chapter[] {
  if (!description || !(durationSeconds! > 0)) return [];
  let run: { start: number; title: string }[] = [];
  const done = (): Chapter[] | null => {
    const kept = run.filter((c) => c.start < durationSeconds!); // ascending: a tail past the end is dropped
    return kept.length >= MIN_CHAPTERS ? kept.slice(0, MAX_CHAPTERS).map((c, i) => ({ ...c, end: kept[i + 1]?.start ?? durationSeconds! })) : null;
  };
  for (const line of description.split(/\r\n|[\n\r\u0085\u2028\u2029]/)) {
    const t = line.trim() ? timestampLine(line) : undefined;
    if (t === undefined) continue; // blank lines do not end a list
    if (t && run.length && t.start > run[run.length - 1].start) run.push(t);
    else {
      const found = done();
      if (found) return found;
      run = t && t.start === 0 ? [t] : []; // a list starts at 0:00; anything else (text, repeats, descending) ends the run
    }
  }
  return done() ?? [];
}
