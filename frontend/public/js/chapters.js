// Chapters and clickable timestamps on the watch page. Loaded lazily, only for a video whose description has timestamps.
// The linking rule is documented in the README ("Chapters and timestamps") and mirrored by the Android app.
import { formatSeconds } from "./fmt.js";
import { $, watchHref } from "./lib.js";

export const TIME = /(?<![\w:/.@#?=&%])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?!\w|:\d|[/.]\w)/g;

// Text -> strings and { t, text } links; only times inside the video (0 <= t < duration) are links.
export function split(text, duration) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(TIME)) {
    const h = m[1] === undefined ? 0 : Number(m[1]), min = Number(m[2]), sec = Number(m[3]);
    const t = h * 3600 + min * 60 + sec;
    if (sec > 59 || (m[1] !== undefined && min > 59) || !(t < duration)) continue;
    if (m.index > at) out.push(text.slice(at, m.index));
    out.push({ t, text: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

// Index of the chapter playing at second t (-1 before the first).
export function indexAt(chapters, t) {
  let i = -1;
  while (i + 1 < chapters.length && chapters[i + 1].start <= t) i++;
  return i;
}

// Target of "previous chapter": restart this one unless it only just began.
export function previousStart(chapters, t) {
  const i = indexAt(chapters, t);
  return i > 0 && t - chapters[i].start <= 3 ? chapters[i - 1].start : (chapters[i]?.start ?? 0);
}

export const SEEK_GAP_MS = 300; // a held key or a frantic click must not restart the stream dozens of times

export function initChapters({ v: { id, durationSeconds: duration }, chapters, player, now = () => performance.now() }) {
  const ctl = () => player.now, video = player.querySelector("video"), start = Number(player.dataset.start) || 0;
  let last = -Infinity;
  // Seeks through the player; without one (unplayable video, "Try anyway" not pressed) the page itself reopens at t, so a click is never a silent no-op.
  const go = (t) => {
    const at = now();
    if (at - last < SEEK_GAP_MS) return;
    last = at;
    const c = ctl();
    if (!c) return location.assign(watchHref(id, `&t=${t}`));
    c.seek(t);
    $("#player")?.scrollIntoView?.({ block: "nearest" });
  };
  const desc = $("#desc");
  const parts = split(desc.textContent, duration);
  if (parts.some((p) => typeof p !== "string")) {
    desc.replaceChildren(...parts.map((p) => {
      if (typeof p === "string") return document.createTextNode(p);
      const a = document.createElement("a");
      a.href = watchHref(id, `&t=${p.t}`); // a real link: new tab and copy-link work, and the page honours ?t=
      a.textContent = p.text;
      a.addEventListener("click", (e) => {
        if (e.defaultPrevented || e.button || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !ctl()) return; // the browser follows the link
        e.preventDefault();
        go(p.t);
      });
      return a;
    }));
  }
  if (!chapters?.length) return;

  player.chapters = chapters; // previews.js adds the chapter name to its time label
  const list = $("#ch-list"), label = $("#ch-name");
  $("#ch-sum").textContent = `Chapters (${chapters.length})`;
  const rows = chapters.map((c) => {
    const li = document.createElement("li"), b = document.createElement("button"), t = document.createElement("span");
    b.type = "button";
    t.className = "ch-t";
    t.textContent = formatSeconds(c.start);
    b.append(t, ` ${c.title}`);
    b.addEventListener("click", () => go(c.start));
    li.append(b);
    list.append(li);
    return b;
  });
  $("#chapters").hidden = false;
  let cur = -2;
  const paint = () => {
    const i = indexAt(chapters, ctl()?.() ?? start);
    if (i === cur) return;
    if (rows[cur]) rows[cur].removeAttribute("aria-current");
    cur = i;
    if (rows[i]) rows[i].setAttribute("aria-current", "true");
    label.textContent = chapters[i]?.title ?? "";
  };
  for (const e of ["timeupdate", "seeked", "loadedmetadata"]) video.addEventListener(e, paint);
  paint();
  // [ and ] jump to the previous / next chapter (not when held down, typed into a field or composed by an IME).
  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey || e.isComposing || e.target?.matches?.("input,select,textarea,[contenteditable]")) return;
    const t = ctl()?.();
    if (t === undefined || (e.key !== "[" && e.key !== "]")) return;
    const to = e.key === "[" ? previousStart(chapters, t) : chapters[indexAt(chapters, t) + 1]?.start;
    if (to !== undefined) go(to);
  });
}
