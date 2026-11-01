import { $, api, cardNode, clone, markWatched, run, safeImg, setTitle, thumbUrl } from "./lib.js";
import { formatViews, join, timeAgo } from "./fmt.js";

const id = decodeURIComponent(location.pathname.split("/")[2] ?? "");
const q = new URLSearchParams(location.search);
const token = q.get("pageToken") ?? "";
const TABS = ["videos", "playlists", "shorts", "live", "about"];
const tab = TABS.includes(q.get("tab")) ? q.get("tab") : "videos";
const list = /^[A-Za-z]{2}[\w-]{8,62}$/.test(q.get("list") ?? "") && tab === "playlists" ? q.get("list") : "";
const base = `/api/channel/${encodeURIComponent(id)}`;
const href = (params) => `/channel/${encodeURIComponent(id)}?${new URLSearchParams(params)}`;
const withToken = (path) => (token ? `${path}${path.includes("?") ? "&" : "?"}${new URLSearchParams({ pageToken: token })}` : path);
const LIVE = { live: "Live now", upcoming: "Upcoming", ended: "Past stream" };

function tabBar() {
  for (const t of TABS) {
    const a = document.createElement("a");
    a.textContent = t[0].toUpperCase() + t.slice(1);
    a.href = href({ tab: t });
    if (t === tab) a.setAttribute("aria-current", "page");
    $("#tabs").append(a);
  }
}

function videos(items, meta) {
  for (const v of items) {
    $("#uploads").append(cardNode({ id: v.id, title: v.title, thumb: v.thumb || thumbUrl(v.id), duration: v.durationSeconds && formatSecondsShort(v.durationSeconds), meta: meta(v) }));
  }
  markWatched();
}
const formatSecondsShort = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

function playlists(items) {
  for (const p of items) {
    const n = clone("t-pl"), to = href({ tab: "playlists", list: p.id });
    n.querySelector(".thumb").href = to;
    n.querySelector("img").src = safeImg(p.thumb);
    $(".title", n).textContent = p.title;
    $(".title", n).href = to;
    $(".meta", n).textContent = p.itemCount === undefined ? "" : `${p.itemCount} video${p.itemCount === 1 ? "" : "s"}`;
    $("#lists").append(n);
  }
}

function about(a) {
  $("#aboutbox").hidden = false;
  $("#about").textContent = a.description || "No description.";
  const day = a.publishedAt ? new Date(a.publishedAt).toISOString().slice(0, 10) : "";
  for (const [k, v] of [["Handle", a.customUrl], ["Joined", day], ["Country", a.country], ["Views", formatViews(a.viewCount).replace(" views", "")], ["Subscribers", a.subscriberCount && Number(a.subscriberCount).toLocaleString("en-US")], ["Videos", a.videoCount]]) {
    if (!v) continue;
    const dt = document.createElement("dt"), dd = document.createElement("dd");
    dt.textContent = k;
    dd.textContent = v;
    $("#facts").append(dt, dd);
  }
  for (const u of a.links) {
    if (!/^https?:\/\//.test(u)) continue;
    const li = document.createElement("li"), link = document.createElement("a");
    link.textContent = u;
    link.href = u;
    link.rel = "noopener noreferrer nofollow";
    li.append(link);
    $("#links").append(li);
  }
}

run(async () => {
  const head = api(base);
  const body = tab === "playlists" ? api(withToken(list ? `${base}/playlist/${encodeURIComponent(list)}` : `${base}/playlists`)) : tab === "videos" ? null : api(withToken(`${base}/${tab}`));
  const { channel: c, page: first, subscribed } = await head;
  const data = await (body ?? { page: first });

  setTitle(c.title);
  $("#channel").hidden = false;
  $("#name").textContent = c.title;
  $("#avatar").src = safeImg(c.thumb);
  if (safeImg(c.banner)) {
    $("#banner").src = `${c.banner}=w1060`;
    $("#banner").hidden = false;
  }
  tabBar();

  const button = $("#sub-btn");
  let on = subscribed;
  const paint = () => (button.textContent = on ? "Unsubscribe" : "Subscribe");
  paint();
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const res = await api(`/api/${on ? "unsubscribe" : "subscribe"}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id }),
      });
      on = res.subscribed;
      button.title = "";
      $("#sub-error").textContent = "";
      paint();
    } catch (err) {
      paint();
      button.title = err.message; // keep the label; show why it failed on hover and to screen readers
      $("#sub-error").textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  const page = data.page;
  $("#sect").textContent = list ? data.playlist.title : tab === "videos" ? "Uploads" : $("#tabs [aria-current]").textContent;
  if (list) {
    $("#sect").prepend(Object.assign(document.createElement("a"), { textContent: "Playlists › ", href: href({ tab: "playlists" }) }));
  }
  if (tab === "about") about(data.about);
  else if (tab === "playlists" && !list) playlists(page.items);
  else videos(page.items, (v) => join(LIVE[v.live], timeAgo(v.publishedAt)));

  const to = (t) => href({ tab, ...(list && { list }), pageToken: t });
  for (const [name, tok] of [["prev", page?.prevPageToken], ["next", page?.nextPageToken]]) {
    if (!tok) continue;
    $(`#${name}`).href = to(tok);
    $(`#${name}`).hidden = false;
  }
  $("#empty").hidden = $("#uploads").children.length + $("#lists").children.length > 0 || !$("#aboutbox").hidden || !$("#next").hidden;
});
