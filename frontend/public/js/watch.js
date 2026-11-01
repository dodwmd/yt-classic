import { $, api, channelHref, clone, fillRow, laterButton, markWatched, reportProgress, run, setTitle, thumbUrl, watchHref } from "./lib.js";
import { formatViews, join, timeAgo, viewsText } from "./fmt.js";
import { initPlayer } from "./player.js";

const params = new URLSearchParams(location.search);
const id = params.get("v") ?? "";
const explicit = params.has("t") ? Math.max(0, Math.floor(Number(params.get("t"))) || 0) : null; // ?t=0 is deliberate: start over

run(async () => {
  const query = new URLSearchParams();
  for (const k of ["q", "a"]) if (params.get(k)) query.set(k, params.get(k));
  const { video: v, related, quality, qualities, lang, progress } = await api(`/api/video/${encodeURIComponent(id)}?${query}`);

  const start = explicit ?? (progress && !progress.completed ? progress.position : 0);
  setTitle(v.title);
  $("#watch").hidden = false;
  $("#title").textContent = v.title;

  const base = `/stream/${encodeURIComponent(v.id)}?q=${quality}${lang ? `&a=${encodeURIComponent(lang)}` : ""}`;
  const player = $("#player");
  player.dataset.duration = v.durationSeconds || 0;
  player.dataset.src = base;
  player.dataset.start = start;
  const video = $("video", player);
  video.poster = thumbUrl(v.id, "hqdefault");
  video.src = start ? `${base}&t=${start}` : base;
  const bar = $(".bar", player);
  bar.max = v.durationSeconds || 0;
  bar.value = start;
  player.hidden = false;
  const now = initPlayer(player);
  if (now) reportProgress(video, now, { id: v.id });

  const extra = lang ? `&a=${encodeURIComponent(lang)}` : "";
  qualities.forEach((h, i) => {
    if (i) $("#quality").append(" · ");
    const el = document.createElement(h === quality ? "b" : "a");
    el.textContent = `${h}p`;
    if (h !== quality) el.href = watchHref(v.id, `&q=${h}${extra}`);
    $("#quality").append(el);
  });

  $("#chan").textContent = v.channelTitle;
  $("#chan").href = channelHref(v.channelId);
  $("#age").textContent = timeAgo(v.publishedAt);
  $("#views").textContent = formatViews(v.views);
  $("#desc").textContent = v.description;

  $("#rel-heading").textContent = related.heading;
  for (const r of related.items) {
    const row = clone("t-rel");
    fillRow(row, r);
    $(".chan", row).textContent = r.channelTitle;
    $(".meta", row).textContent = join(r.views && viewsText(r.views), r.age || (r.publishedAt && timeAgo(r.publishedAt)));
    $("#rel-list").append(row);
  }
  markWatched();
  const { watchLater } = await api(`/api/playlists/membership?ids=${v.id}`).catch(() => ({}));
  if (!watchLater) return; // unknown: no button rather than a wrong one
  const [btn, msg] = laterButton(v.id, watchLater.includes(v.id), v.title, ["Watch later", "\u2713 In Watch later"]);
  btn.className = msg.className = "";
  btn.id = "later";
  $("#later-box").append(btn, msg);
});
