import { formatSeconds } from "./fmt.js";

// Shared helpers; DOM text only via textContent (a test enforces it).

export const $ = (sel, root = document) => root.querySelector(sel);

export async function api(path, init) {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) { // the page is going away, so never resolve
    location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
    return new Promise(() => {});
  }
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const WATCH = /^\/watch\?v=([\w-]{11})/, CHANNEL = /^\/channel\/(UC[\w-]{22})$/;
const PAGES = new Map([["/history", "/history"], ["/subscriptions", "/subscriptions"]]);
export function destination(next) {
  const w = WATCH.exec(next), c = CHANNEL.exec(next);
  return w ? "/watch?v=" + w[1] : c ? "/channel/" + c[1] : PAGES.get(next) || "/";
}

const login = document.getElementById("login");
if (login) login.action = "/api/login?next=" + encodeURIComponent(destination(new URLSearchParams(location.search).get("next")));

export const clone = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

export const safeImg = (u) => (typeof u === "string" && u.startsWith("https://") ? u : "");

export const watchHref = (id, extra = "") => `/watch?v=${encodeURIComponent(id)}${extra}`;
export const channelHref = (id) => `/channel/${encodeURIComponent(id)}`;
export const thumbUrl = (id, size = "mqdefault") => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${size}.jpg`;

export async function run(main) {
  const status = $("#status");
  try {
    await main();
    status.hidden = true;
    fetch("/api/session").then((r) => r.json()).then((s) => ($("#foot").hidden = s.auth !== "required" || !s.authenticated)).catch(() => {});
  } catch (err) {
    status.textContent = err.message || String(err);
    status.hidden = false;
  }
}

export function setTitle(title) {
  document.title = `${title} - YouTube Classic`;
}

export function fillRow(row, { id, title, thumb, duration }) {
  $(".thumb", row).href = watchHref(id);
  $("img", row).src = safeImg(thumb);
  if (duration) {
    $(".dur", row).textContent = duration;
    $(".dur", row).hidden = false;
  }
  $(".title", row).textContent = title;
  $(".title", row).href = watchHref(id);
}

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

function progressBar(thumb, pct) {
  const bar = document.createElement("span");
  bar.className = "prog";
  bar.append(document.createElement("i"));
  bar.firstChild.style.width = `${Math.min(100, Math.max(0, pct))}%`;
  thumb.append(bar);
}

const pctOf = (h) => (h.durationSeconds ? Math.round((100 * h.position) / h.durationSeconds) : 0);

export const historyCard = (h, meta) => cardNode({
  id: h.id, title: h.title, thumb: thumbUrl(h.id), duration: h.durationSeconds && formatSeconds(h.durationSeconds),
  channelId: h.channelId, channelTitle: h.channelTitle, pct: h.completed ? 0 : pctOf(h), meta,
});

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
  }
}
