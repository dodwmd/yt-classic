import { $, api, channelHref, clone, fillRow, markWatched, run, safeImg, setTitle } from "./lib.js";
import { subToggle } from "./sub.js";
import { formatSeconds, formatViews, join, timeAgo } from "./fmt.js";

// Everything the page shows is read from the URL, so a results page can be shared; unknown values fall back to defaults.
const params = new URLSearchParams(location.search);
const q = params.get("search_query") ?? "";
const pick = (name, allowed) => (allowed.includes(params.get(name)) ? params.get(name) : allowed[0]);
const type = pick("type", ["video", "channel"]);
const duration = pick("duration", ["any", "short", "medium", "long"]);
const sort = pick("sort", ["relevance", "date", "views"]);
$("#q").value = q;

const here = (extra) => `/results?${new URLSearchParams({ search_query: q, ...extra })}`;

function filters() {
  $("#filters").hidden = false;
  $("#fq").value = q;
  $("#ftype").value = type;
  $("#fdur").value = duration;
  $("#fsort").value = sort;
  $("#fopts").hidden = type !== "video";
  for (const t of ["video", "channel"]) {
    $(`#ty-${t}`).href = here({ type: t });
    if (t === type) $(`#ty-${t}`).setAttribute("aria-current", "page");
  }
  $("#fdur").addEventListener("change", () => $("#filters").requestSubmit());
  $("#fsort").addEventListener("change", () => $("#filters").requestSubmit());
  $("#clear-recent").addEventListener("click", async () => {
    try {
      await api("/api/searches", { method: "DELETE" });
      $("#clear-msg").textContent = "Recent searches cleared.";
    } catch (err) {
      $("#clear-msg").textContent = err.message;
    }
  });
}

function channelRow(c) {
  const row = clone("t-channel");
  const href = channelHref(c.id);
  $(".thumb", row).href = href;
  $(".thumb", row).setAttribute("aria-label", c.title);
  $("img", row).src = safeImg(c.thumb);
  $(".title", row).textContent = c.title;
  $(".title", row).href = href;
  $(".extra", row).textContent = join(c.handle, c.subscribers && `${Number(c.subscribers).toLocaleString("en-US")} subscribers`);
  $(".desc", row).textContent = c.description;
  subToggle($(".subbtn", row), c.id, c.subscribed, $(".suberr", row));
  return row;
}

function videoRow(v) {
  const row = clone("t-result");
  fillRow(row, { ...v, duration: v.durationSeconds && formatSeconds(v.durationSeconds) });
  $(".chan", row).textContent = v.channelTitle;
  $(".chan", row).href = channelHref(v.channelId);
  const extra = join(v.publishedAt && timeAgo(v.publishedAt), v.views && formatViews(v.views));
  $(".extra", row).textContent = extra ? ` · ${extra}` : "";
  $(".desc", row).textContent = v.description;
  return row;
}

run(async () => {
  if (!q.trim()) {
    location.replace("/");
    return;
  }
  setTitle(`${q} - Search`);
  filters();
  const query = new URLSearchParams({ q, type, duration, sort });
  if (params.get("pageToken")) query.set("pageToken", params.get("pageToken"));
  const page = await api(`/api/search?${query}`);
  const rows = type === "channel" ? page.channels : page.items;

  $("#heading").textContent = `${type === "channel" ? "Channels" : "Results"} for "${q}"`;
  $("#heading").hidden = false;
  $("#notes").textContent = (page.notes ?? []).join(" ");
  $("#notes").hidden = !page.notes?.length;
  if (!rows.length) $("#none").hidden = false;
  $("#results").append(...rows.map(type === "channel" ? channelRow : videoRow));
  markWatched();
  for (const [id, tok] of [["prev", page.prevPageToken], ["next", page.nextPageToken]]) {
    if (!tok) continue;
    $(`#${id}`).href = here({ type, duration, sort, pageToken: tok });
    $(`#${id}`).hidden = false;
  }
});
