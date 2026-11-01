import type { SearchPage } from "../yt/api.ts";
import { esc, layout } from "./layout.ts";
import { formatViews, timeAgo } from "../format.ts";

export function resultsPage(q: string, page: SearchPage): string {
  const rows = page.items.map((v) => `
<div class="result">
  <a class="thumb" href="/watch?v=${esc(v.id)}"><img src="${esc(v.thumb)}" width="160" height="90" alt="">
    ${v.durationLabel ? `<span class="dur">${esc(v.durationLabel)}</span>` : ""}</a>
  <div class="meta">
    <a class="title" href="/watch?v=${esc(v.id)}">${esc(v.title)}</a>
    <div class="sub">by <a href="/channel/${esc(v.channelId)}">${esc(v.channelTitle)}</a>${[v.publishedAt && timeAgo(v.publishedAt), v.views && formatViews(v.views)].filter(Boolean).map((t) => ` · ${esc(t as string)}`).join("")}</div>
    <div class="desc">${esc(v.description)}</div>
  </div>
</div>`).join("");
  const link = (label: string, tok?: string) =>
    tok ? `<a href="/results?${new URLSearchParams({ search_query: q, pageToken: tok })}">${label}</a>` : "";
  const pager = `<div class="pager">${link("&laquo; Previous", page.prevPageToken)} ${link("Next &raquo;", page.nextPageToken)}</div>`;
  return layout(`${q} - Search`, `<h2>Results for "${esc(q)}"</h2>${rows || "<p>No results.</p>"}${pager}`, q);
}
