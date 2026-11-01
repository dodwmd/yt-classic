import { $, api, channelHref, clone, explain, fillRow, laterButton, markWatched, reportProgress, run, setTitle, thumbUrl, watchHref } from "./lib.js";
import { formatViews, join, timeAgo, viewsText } from "./fmt.js";
import { initPlayer } from "./player.js";

const params = new URLSearchParams(location.search);
const id = params.get("v") ?? "";
const explicit = params.has("t") ? Math.max(0, Math.floor(Number(params.get("t"))) || 0) : null; // ?t=0 is deliberate: start over

run(async () => {
  const query = new URLSearchParams();
  for (const k of ["q", "a"]) if (params.get(k)) query.set(k, params.get(k));
  const { video: v, related, quality, qualities, lang, progress, playable, message } = await api(`/api/video/${encodeURIComponent(id)}?${query}`);

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
  const bar = $(".bar", player);
  bar.max = v.durationSeconds || 0;
  bar.value = start;
  // When the server already knows the video can't play, say why and wait for "Try anyway": nothing is requested until then.
  const mount = () => {
    video.src = start ? `${base}&t=${start}` : base;
    player.hidden = false;
    const now = initPlayer(player);
    if (now) reportProgress(video, now, { id: v.id });
    video.addEventListener("error", () => explainFailure(video));
  };
  if (playable === false) {
    $("#try").hidden = false;
    $("#try").onclick = () => { $("#try").hidden = $("#status").hidden = true; mount(); };
  } else mount();

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
  if (watchLater) { // unknown: no button rather than a wrong one
    const [btn, msg] = laterButton(v.id, watchLater.includes(v.id), v.title, ["Watch later", "\u2713 In Watch later"]);
    btn.className = msg.className = "";
    btn.id = "later";
    $("#later-box").append(btn, msg);
  }
  return playable === false ? message : "";
});

// The stream's JSON error (sent before any video bytes) is invisible to <video>: ask the stream route's probe (it
// resolves like a stream, reusing a recent failure, but never starts ffmpeg or takes a stream slot) and show the reason.
async function explainFailure(video) {
  try {
    const r = await fetch(`${video.currentSrc}&probe=1`);
    const b = r.ok ? null : await r.json();
    if (b && b.error) { $("#status").textContent = explain(b); $("#status").hidden = false; }
  } catch {
  }
}
