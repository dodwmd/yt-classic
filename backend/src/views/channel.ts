import type { Channel, SearchPage } from "../yt/api.ts";
import { esc, layout } from "./layout.ts";
import { timeAgo } from "../format.ts";

export function channelPage(c: Channel, page: SearchPage, subscribed: boolean): string {
  const cards = page.items.map((v) => `
<div class="card"><a href="/watch?v=${esc(v.id)}"><img src="${esc(v.thumb)}" width="160" height="90" alt=""></a>
  <a class="title" href="/watch?v=${esc(v.id)}">${esc(v.title)}</a>
  <div class="sub">${esc(timeAgo(v.publishedAt))}</div></div>`).join("");
  const link = (label: string, tok?: string) => (tok ? `<a href="/channel/${esc(c.id)}?pageToken=${encodeURIComponent(tok)}">${label}</a>` : "");
  const btn = subscribed ? "Unsubscribe" : "Subscribe";
  const action = subscribed ? "/unsubscribe" : "/subscribe";
  const body = `
${c.banner ? `<img class="banner" src="${esc(c.banner)}=w1060" alt="">` : ""}
<div class="chead"><img src="${esc(c.thumb)}" width="48" height="48" alt="">
  <h1>${esc(c.title)}</h1>
  <form method="post" action="${action}"><input type="hidden" name="id" value="${esc(c.id)}"><button type="submit">${btn}</button></form></div>
<details><summary>About</summary><div class="desc">${esc(c.description)}</div></details>
<h3>Uploads</h3><div class="grid">${cards}</div>
<nav class="pager" aria-label="Pagination">${link("&laquo; Newer", page.prevPageToken)} ${link("Older &raquo;", page.nextPageToken)}</nav>`;
  return layout(c.title, body);
}
