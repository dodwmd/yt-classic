import type { VideoDetail } from "../yt/api.ts";
import type { RelatedList } from "../yt/related.ts";
import { esc, layout } from "./layout.ts";
import { QUALITIES } from "../yt/dlp.ts";
import { formatViews, isoSeconds, timeAgo, viewsText } from "../format.ts";

function player(v: VideoDetail, q: number, t: number, a: string): string {
  const base = `/stream/${esc(v.id)}?q=${q}${a ? `&amp;a=${esc(a)}` : ""}`;
  const src = t ? `${base}&amp;t=${t}` : base;
  return `<div id="player" data-duration="${isoSeconds(v.duration)}" data-src="${base}" data-start="${t}">
  <video controls autoplay preload="auto" width="640" height="360" poster="https://i.ytimg.com/vi/${esc(v.id)}/hqdefault.jpg" src="${src}">Your browser can't play this video.</video>
  <div class="controls" hidden>
    <button class="pp" type="button" aria-label="Play or pause">&#9654;</button>
    <input class="bar" type="range" aria-label="Seek" min="0" max="${isoSeconds(v.duration)}" step="1" value="${t}">
    <span class="time"></span>
    <input class="vol" type="range" aria-label="Volume" min="0" max="1" step="0.05" value="1">
    <button class="fs" type="button" aria-label="Fullscreen">&#9974;</button>
  </div>
</div>`;
}

export function watchPage(v: VideoDetail, related: RelatedList, q: number, t: number, audio: string | null): string {
  const a = audio && /^[a-z]{2,3}$/.test(audio) ? audio : "";
  const quality = QUALITIES.map((h) => (h === q ? `<b>${h}p</b>` : `<a href="/watch?v=${esc(v.id)}&amp;q=${h}${a ? `&amp;a=${esc(a)}` : ""}">${h}p</a>`)).join(" · ");
  const rel = related.items.map((r) => `
<div class="rel"><a class="thumb" href="/watch?v=${esc(r.id)}"><img src="${esc(r.thumb)}" width="120" height="68" alt="">${r.duration ? `<span class="dur">${esc(r.duration)}</span>` : ""}</a>
  <div><a class="title" href="/watch?v=${esc(r.id)}">${esc(r.title)}</a>
  <div class="sub">${esc(r.channelTitle)}<br>${[r.views && viewsText(r.views), r.age].filter(Boolean).map((t) => esc(t as string)).join(" · ")}</div></div></div>`).join("");
  const body = `
<div id="watch">
  <div id="main">
    <h1>${esc(v.title)}</h1>
    ${player(v, q, t, a)}
    <div class="quality">Quality: ${quality}</div>
    <div class="info">
      <div class="by">Uploaded by <a href="/channel/${esc(v.channelId)}">${esc(v.channelTitle)}</a> ${esc(timeAgo(v.publishedAt))}</div>
      <div class="views">${esc(formatViews(v.views))}</div>
    </div>
    <details open><summary>Description</summary><div class="desc">${esc(v.description)}</div></details>
  </div>
  <div id="related"><h3>${esc(related.heading)}</h3>${rel}</div>
</div>`;
  return layout(v.title, body, "", `<script src="/static/player.js" defer></script>`);
}
