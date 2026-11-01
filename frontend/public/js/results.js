import { $, api, channelHref, clone, markWatched, run, safeImg, setTitle, watchHref } from "./lib.js";
import { formatSeconds, formatViews, join, timeAgo } from "./fmt.js";

const params = new URLSearchParams(location.search);
const q = params.get("search_query") ?? "";
$("#q").value = q;

run(async () => {
  if (!q.trim()) {
    location.replace("/");
    return;
  }
  setTitle(`${q} - Search`);
  const query = new URLSearchParams({ q });
  if (params.get("pageToken")) query.set("pageToken", params.get("pageToken"));
  const page = await api(`/api/search?${query}`);

  $("#heading").textContent = `Results for "${q}"`;
  $("#heading").hidden = false;
  if (!page.items.length) $("#none").hidden = false;
  for (const v of page.items) {
    const row = clone("t-result");
    $(".thumb", row).href = watchHref(v.id);
    $("img", row).src = safeImg(v.thumb);
    if (v.durationSeconds) {
      $(".dur", row).textContent = formatSeconds(v.durationSeconds);
      $(".dur", row).hidden = false;
    }
    $(".title", row).textContent = v.title;
    $(".title", row).href = watchHref(v.id);
    $(".chan", row).textContent = v.channelTitle;
    $(".chan", row).href = channelHref(v.channelId);
    const extra = join(v.publishedAt && timeAgo(v.publishedAt), v.views && formatViews(v.views));
    $(".extra", row).textContent = extra ? ` · ${extra}` : "";
    $(".desc", row).textContent = v.description;
    $("#results").append(row);
  }
  markWatched();
  for (const [id, tok] of [["prev", page.prevPageToken], ["next", page.nextPageToken]]) {
    if (!tok) continue;
    $(`#${id}`).href = `/results?${new URLSearchParams({ search_query: q, pageToken: tok })}`;
    $(`#${id}`).hidden = false;
  }
});
