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
  if (!res.ok) throw Object.assign(new Error(body.error || `Request failed (${res.status})`), { code: body.code });
  return body;
}

// A channel URL's tab, playlist and page token: the same allowlists as the backend's (a test keeps the playlist id pattern in step).
export const TABS = ["videos", "playlists", "shorts", "live", "about"];
const LIST_ID = /^(?:PL[\w-]{16,32}|UU[\w-]{22}|OL[\w-]{20,40}|FL[\w-]{22}|LL[\w-]{22})$/, TOKEN = /^[\w-]{1,120}$/;
export function channelParams(q) {
  const tab = TABS.includes(q.get("tab")) ? q.get("tab") : "videos";
  return { tab, list: tab === "playlists" && LIST_ID.test(q.get("list")) ? q.get("list") : "", pageToken: TOKEN.test(q.get("pageToken")) ? q.get("pageToken") : "" };
}
export function channelHref(id, { tab = "videos", list = "", pageToken = "" } = {}) {
  const q = new URLSearchParams();
  if (tab !== "videos") q.set("tab", tab);
  if (list) q.set("list", list);
  if (pageToken) q.set("pageToken", pageToken);
  return `/channel/${encodeURIComponent(id)}${q.size ? `?${q}` : ""}`;
}
// The two API requests a channel page makes: the header (never the uploads, except for the Videos tab) and the tab's data.
export function channelRequests(id, { tab, list, pageToken }) {
  const base = `/api/channel/${encodeURIComponent(id)}`, tok = pageToken ? `?${new URLSearchParams({ pageToken })}` : "";
  if (tab === "videos") return { head: `${base}${tok}`, body: null };
  return { head: `${base}/head`, body: `${base}/${tab === "playlists" && list ? `playlist/${encodeURIComponent(list)}` : tab}${tok}` };
}

const WATCH = /^\/watch\?v=([\w-]{11})/, CHANNEL = /^\/channel\/(UC[\w-]{22})(?:\?([^#]*))?$/, LISTS = /^\/playlists(?:\?id=(\d{1,9}))?$/;
const PAGES = new Map([["/history", "/history"], ["/subscriptions", "/subscriptions"], ["/tv", "/tv"]]);
export function destination(next) {
  const w = WATCH.exec(next), c = CHANNEL.exec(next), l = LISTS.exec(next);
  return w ? "/watch?v=" + w[1] : c ? channelHref(c[1], channelParams(new URLSearchParams(c[2]))) : l ? "/playlists" + (l[1] ? "?id=" + l[1] : "") : PAGES.get(next) || "/";
}

const login = document.getElementById("login");
if (login) login.action = "/api/login?next=" + encodeURIComponent(destination(new URLSearchParams(location.search).get("next")));

export const clone = (id) => document.getElementById(id).content.firstElementChild.cloneNode(true);

export const safeImg = (u) => (typeof u === "string" && u.startsWith("https://") ? u : "");

export const watchHref = (id, extra = "") => `/watch?v=${encodeURIComponent(id)}${extra}`;
export const thumbUrl = (id, size = "mqdefault") => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${size}.jpg`;

export async function run(main) {
  const status = $("#status");
  try {
    await main();
    status.hidden = true;
    tvLink();
    fetch("/api/session").then((r) => r.json()).then((s) => ($("#foot").hidden = s.auth !== "required" || !s.authenticated)).catch(() => {});
  } catch (err) {
    status.textContent = err.message || String(err);
    status.hidden = false;
  }
}

// The masthead's TV entry stays a link (the TV page explains), but is greyed and, when TV is not available yet, says why
// in visible text that the link is described by.
function tvLink() {
  const a = $("#tvlink");
  if (!a) return;
  fetch("/api/tv/status").then((r) => r.json()).then((s) => {
    if (s.ok || !s.need) return;
    const more = s.need - s.have, hint = document.createElement("span");
    hint.id = "tvhint";
    hint.className = "hint";
    hint.textContent = `Subscribe to ${more} more channel${more === 1 ? "" : "s"} to turn on TV`;
    a.after(hint);
    a.setAttribute("aria-disabled", "true");
    a.setAttribute("aria-describedby", "tvhint");
  }).catch(() => {});
}

// Reports progress every 10 s while playing and on pause/end/leave, once something has really played.
// ref.id is the video being reported (TV changes it, and leaves it empty while nothing should be reported); returns send(finished).
export function reportProgress(video, now, ref) {
  let last = -1, played = false;
  const send = (finished) => {
    const position = Math.floor(now());
    if (!ref.id || !played || (!finished && position === last)) return;
    last = position;
    const body = new URLSearchParams({ id: ref.id, position });
    if (finished) body.set("finished", 1);
    fetch("/api/progress", { method: "POST", body, keepalive: true }).catch(() => {});
  };
  setInterval(() => video.paused || send(), 10000);
  video.addEventListener("playing", () => (played = true));
  video.addEventListener("loadstart", () => (played = false));
  video.addEventListener("pause", () => send());
  video.addEventListener("ended", () => send(true));
  addEventListener("pagehide", () => send());
  document.addEventListener("visibilitychange", () => document.hidden && send());
  return send;
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

const form = { "content-type": "application/x-www-form-urlencoded" };

// Watch later toggle. A button (touch and keyboard), never inside a link; a failure is shown right next to it.
export function laterButton(id, on, title, [add, added] = ["+", "\u2713"]) {
  const b = document.createElement("button"), msg = document.createElement("span");
  b.type = "button";
  b.className = "later";
  msg.className = "later-msg";
  msg.setAttribute("role", "alert");
  b.setAttribute("aria-label", `Watch later: ${title}`);
  const paint = () => {
    b.textContent = on ? added : add;
    b.setAttribute("aria-pressed", on);
  };
  paint();
  b.addEventListener("click", async () => {
    b.disabled = true;
    try {
      await api(on ? `/api/playlists/1/items/${id}` : "/api/playlists/1/items", on ? { method: "DELETE" } : { method: "POST", headers: form, body: new URLSearchParams({ id }) });
      on = !on;
      msg.textContent = "";
    } catch (err) {
      msg.textContent = err.message || "Failed";
    }
    paint();
    b.disabled = false;
  });
  return [b, msg];
}

// Thumbs not decorated yet (a later page only decorates its new cards). Marks them, so call it once the data is in.
export const undecorated = (thumbs) => thumbs.filter((a) => !a.dataset.d);

export async function markWatched() {
  try {
    const thumbs = undecorated([...document.querySelectorAll('.thumb[href^="/watch?v="]')]).slice(0, 100);
    const id = (a) => new URLSearchParams(a.search).get("v");
    if (!thumbs.length) return;
    const list = thumbs.map(id).join(",");
    // Without a known membership no toggle is shown (it would claim "not in Watch later"); the next call retries.
    const [{ ids }, { watchLater }] = await Promise.all([api(`/api/history/watched?ids=${list}`).catch(() => ({ ids: [] })), api(`/api/playlists/membership?ids=${list}`)]);
    for (const a of thumbs) {
      a.dataset.d = 1;
      if (ids.includes(id(a))) {
        const b = document.createElement("span");
        b.className = "badge";
        b.textContent = "Watched";
        a.append(b);
      }
      a.parentElement.append(...laterButton(id(a), watchLater.includes(id(a)), $(".title", a.parentElement)?.textContent ?? ""));
    }
  } catch {
  }
}
