import type { Subscription } from "../store.ts";
import type { FeedItem } from "../yt/rss.ts";
import type { RelatedItem } from "../yt/innertube.ts";
import { esc, layout } from "./layout.ts";
import { formatViews, timeAgo, viewsText } from "../format.ts";

export function homePage(subs: Subscription[], feed: FeedItem[], recs: RelatedItem[]): string {
  if (!subs.length) {
    return layout("Home", `<h2>Subscriptions</h2><p>No subscriptions yet. Search for a video, open its channel and click Subscribe.</p>`);
  }
  const cards = feed.map((v) => `
<div class="card"><a href="/watch?v=${esc(v.id)}"><img src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" width="160" height="90" alt=""></a>
  <a class="title" href="/watch?v=${esc(v.id)}"${v.description ? ` title="${esc(v.description)}"` : ""}>${esc(v.title)}</a>
  <div class="sub"><a href="/channel/${esc(v.channelId)}">${esc(v.channelTitle)}</a><br>${[v.views && formatViews(v.views), timeAgo(v.publishedAt)].filter(Boolean).map((t) => esc(t as string)).join(" · ")}</div></div>`).join("");
  const recCards = recs.map((r) => `
<div class="card"><a class="thumb" href="/watch?v=${esc(r.id)}"><img src="${esc(r.thumb)}" width="160" height="90" alt="">${r.duration ? `<span class="dur">${esc(r.duration)}</span>` : ""}</a>
  <a class="title" href="/watch?v=${esc(r.id)}">${esc(r.title)}</a>
  <div class="sub">${esc(r.channelTitle)}<br>${[r.views && viewsText(r.views), r.age].filter(Boolean).map((t) => esc(t as string)).join(" · ")}</div></div>`).join("");
  const side = subs.map((s) => `<li><a href="/channel/${esc(s.id)}">${esc(s.title)}</a></li>`).join("");
  const recSection = recs.length ? `<h3>Recommended for you</h3><div class="grid">${recCards}</div>` : "";
  return layout("Home", `<div id="home"><div id="feed"><h3>New from your subscriptions</h3><div class="grid">${cards}</div>${recSection}</div><div id="subs"><h3>Subscriptions</h3><ul>${side}</ul></div></div>`);
}
