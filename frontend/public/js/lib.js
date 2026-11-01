// Small helpers shared by the pages. Data is only ever put into the DOM with textContent and property
// assignment, never as HTML strings (a test enforces this).

export const $ = (sel, root = document) => root.querySelector(sel);

export async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export const clone = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

/** Only https image URLs from the API are used. */
export const safeImg = (u) => (typeof u === "string" && u.startsWith("https://") ? u : "");

export const watchHref = (id, extra = "") => `/watch?v=${encodeURIComponent(id)}${extra}`;
export const channelHref = (id) => `/channel/${encodeURIComponent(id)}`;
export const thumbUrl = (id, size = "mqdefault") => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${size}.jpg`;

/** Show "Loading…" until main() finishes, or the error message if it throws. */
export async function run(main) {
  const status = $("#status");
  try {
    await main();
    status.hidden = true;
  } catch (err) {
    status.textContent = err.message || String(err);
    status.hidden = false;
  }
}

export function setTitle(title) {
  document.title = `${title} - YouTube Classic`;
}

/** Fill a #t-card template: { id, title, thumb, duration?, tooltip?, channelId?, channelTitle?, meta? } */
export function cardNode(c) {
  const n = clone("t-card");
  n.querySelector(".thumb").href = watchHref(c.id);
  n.querySelector("img").src = safeImg(c.thumb);
  if (c.duration) {
    const d = $(".dur", n);
    d.textContent = c.duration;
    d.hidden = false;
  }
  const title = $(".title", n);
  title.textContent = c.title;
  title.href = watchHref(c.id);
  if (c.tooltip) title.title = c.tooltip;
  if (c.channelId) {
    const a = $(".chan", n);
    a.textContent = c.channelTitle;
    a.href = channelHref(c.channelId);
    a.hidden = false;
  } else if (c.channelTitle) {
    const b = $(".byline", n);
    b.textContent = c.channelTitle;
    b.hidden = false;
  }
  $(".meta", n).textContent = c.meta || "";
  if (c.pct) progressBar($(".thumb", n), c.pct);
  return n;
}

/** A thin bar along the bottom of a thumbnail; the width is set through the CSSOM, never as inline HTML. */
function progressBar(thumb, pct) {
  const bar = document.createElement("span");
  bar.className = "prog";
  bar.append(document.createElement("i"));
  bar.firstChild.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  thumb.append(bar);
}

/** Percent watched for a history item (0 when the length is unknown). */
export const pctOf = (h) => (h.durationSeconds ? Math.round((100 * h.position) / h.durationSeconds) : 0);

/** Adds a "Watched" badge to every video thumbnail on the page that has been watched to the end. Never fails the page. */
export async function markWatched() {
  try {
    const thumbs = [...document.querySelectorAll('.thumb[href^="/watch?v="]')].slice(0, 100);
    const id = (a) => new URLSearchParams(a.search).get("v");
    if (!thumbs.length) return;
    const { ids } = await api(`/api/history/watched?ids=${thumbs.map(id).join(",")}`);
    for (const a of thumbs) {
      if (!ids.includes(id(a))) continue;
      const b = document.createElement("span");
      b.className = "badge";
      b.textContent = "Watched";
      a.append(b);
    }
  } catch {
    // badges are a nicety
  }
}
