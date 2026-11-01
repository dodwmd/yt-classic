import { $, api, channelHref, reportProgress, run, setTitle, thumbUrl } from "./lib.js";
import { initPlayer } from "./player.js";

// TV: one video after another from the subscriptions, nothing to choose. The server picks (see /api/tv/next);
// this page only plays, remembers the last ~50 ids so they do not repeat, and stops when things keep failing.
const KEY = "tv.seen", KEEP = 50, MAX_FAILS = 3, REPORT_AFTER = 30;

/**
 * The decision logic, with the page's side effects injected so it can be tested. One request at a time: a second
 * next() while one is running is ignored, and a response that arrives after stop() (or after another request took
 * over) is dropped without playing. fetchNext(signal) resolves {video, ...} or rejects (err.code "need-subscriptions"
 * ends TV); show(r) plays it; finish(message) ends the session; busy(flag) greys Skip while a request runs.
 */
export function tvController({ fetchNext, show, finish, wait, busy = () => {}, maxFails = MAX_FAILS }) {
  let running = false, over = false, token = 0, fails = 0, ctl = null, shown = false;
  const end = (message) => { over = true; token++; ctl?.abort(); finish(message); };
  const self = {
    get over() { return over; },
    async next() {
      if (running || over) return;
      running = true;
      busy(true);
      const mine = ++token;
      try {
        while (!over && mine === token) {
          ctl = new AbortController();
          let r;
          try {
            r = await fetchNext(ctl.signal);
          } catch (err) {
            if (over || mine !== token) return;
            if (err.code === "need-subscriptions") return end(shown ? `TV stopped. ${err.message}` : err.message);
            if (++fails >= maxFails) return end(`TV stopped: ${err.message} (${maxFails} failures in a row).`);
            await wait(1000);
            continue;
          }
          if (over || mine !== token) return;
          shown = true;
          show(r);
          return;
        }
      } finally {
        if (mine === token) { running = false; busy(false); }
      }
    },
    stop() { over = true; token++; ctl?.abort(); },
    playing() { fails = 0; },
    // The video itself would not play.
    broken(message) {
      if (over || !shown || running) return; // a request is already replacing it
      if (++fails >= maxFails) end(message);
      else self.next();
    },
  };
  return self;
}

const recall = () => {
  try { return JSON.parse(sessionStorage.getItem(KEY)).filter((i) => typeof i === "string").slice(-KEEP); } catch { return []; }
};
const remember = (id) => {
  try { sessionStorage.setItem(KEY, JSON.stringify([...recall(), id].slice(-KEEP))); } catch { /* private mode or full: repeats are only less likely to be avoided */ }
};

function wire() {
  const player = $("#player"), video = $("video", player);
  const ref = { id: "" }; // what is reported to the history: empty until the video has really been watched
  let after = "", current = "", now, send;

  const tv = tvController({
    fetchNext: (signal) => api(`/api/tv/next?after=${encodeURIComponent(after)}&seen=${recall().join(",")}`, { signal }),
    wait: (ms) => new Promise((r) => setTimeout(r, ms)),
    busy: (b) => ($("#skip").disabled = b),
    finish(message) {
      video.pause();
      $("#tvbox").hidden = true;
      $("#tv-end").hidden = false;
      $("#tv-msg").textContent = message;
    },
    show({ video: v, quality }) {
      const base = `/stream/${encodeURIComponent(v.id)}?q=${quality}`;
      ref.id = ""; // nothing is reported for it (and so no history row is made) until it has played REPORT_AFTER seconds or ended
      current = v.id;
      player.dataset.duration = v.durationSeconds;
      player.dataset.src = base;
      player.dataset.start = 0;
      video.poster = thumbUrl(v.id, "hqdefault");
      video.src = base;
      after = v.channelId;
      remember(v.id);
      $("#np-title").textContent = v.title;
      $("#np-chan").textContent = v.channelTitle;
      $("#np-chan").href = channelHref(v.channelId);
      setTitle(v.title);
      $("#tvbox").hidden = false;
      if (now) now.reset();
      else {
        const arm = (e) => { if (!ref.id && (e.type === "ended" || now() >= REPORT_AFTER)) ref.id = current; };
        video.addEventListener("timeupdate", arm);
        video.addEventListener("ended", arm); // before reportProgress's own listener, so the finish is reported
        now = initPlayer(player, () => tv.next());
        send = reportProgress(video, now, ref);
      }
    },
  });

  video.addEventListener("playing", () => tv.playing());
  video.addEventListener("error", () => tv.broken(`TV stopped: videos would not play (${MAX_FAILS} failures in a row).`));
  $("#skip").addEventListener("click", () => {
    if (send) send();
    tv.next();
  });
  $("#stop").addEventListener("click", () => {
    tv.stop();
    if (send) send();
    if (history.length > 1) history.back();
    else location.assign("/");
  });
  run(() => tv.next());
}

if (document.getElementById("tvbox")) wire();
