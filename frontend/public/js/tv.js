import { $, api, channelHref, reportProgress, run, setTitle, thumbUrl } from "./lib.js";
import { initPlayer } from "./player.js";

// TV: one video after another from the subscriptions, nothing to choose. The server picks (see /api/tv/next);
// this page only plays, remembers the last ~50 ids so they do not repeat, and stops when things keep failing.
const KEY = "tv.seen", KEEP = 50, MAX_FAILS = 3;
const player = $("#player"), video = $("video", player);
const ref = { id: "" };
let after = "", fails = 0, now, send, over = false;

const recall = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY)).filter((i) => typeof i === "string").slice(-KEEP); } catch { return []; }
};

function finish(message) {
  over = true;
  video.pause();
  $("#tvbox").hidden = true;
  $("#tv-end").hidden = false;
  $("#tv-msg").textContent = message;
}

function show(v, quality) {
  const base = `/stream/${encodeURIComponent(v.id)}?q=${quality}`;
  player.dataset.duration = v.durationSeconds;
  player.dataset.src = base;
  player.dataset.start = 0;
  video.poster = thumbUrl(v.id, "hqdefault");
  video.src = base;
  ref.id = v.id;
  after = v.channelId;
  sessionStorage.setItem(KEY, JSON.stringify([...recall(), v.id].slice(-KEEP)));
  $("#np-title").textContent = v.title;
  $("#np-chan").textContent = v.channelTitle;
  $("#np-chan").href = channelHref(v.channelId);
  setTitle(v.title);
  if (now) now.reset();
  else {
    now = initPlayer(player, next);
    send = reportProgress(video, now, ref);
  }
}

// Each failure (no video found, or one that will not play) counts; a video that really plays resets the count.
async function next() {
  while (!over) {
    try {
      const { video: v, quality } = await api(`/api/tv/next?after=${encodeURIComponent(after)}&seen=${recall().join(",")}`);
      show(v, quality);
      $("#tvbox").hidden = false;
      return;
    } catch (err) {
      if (err.code === "need-subscriptions") return finish(ref.id ? `TV stopped. ${err.message}` : err.message);
      if (++fails >= MAX_FAILS) return finish(`TV stopped: ${err.message} (${MAX_FAILS} failures in a row).`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

video.addEventListener("playing", () => (fails = 0));
video.addEventListener("error", () => {
  if (over || !ref.id) return;
  if (++fails >= MAX_FAILS) finish(`TV stopped: videos would not play (${MAX_FAILS} failures in a row).`);
  else next();
});
$("#skip").addEventListener("click", () => {
  if (send) send();
  next();
});
$("#stop").addEventListener("click", () => {
  over = true;
  if (send) send();
  if (history.length > 1) history.back();
  else location.assign("/");
});

run(next);
