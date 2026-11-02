// onended: called when the video plays to its end. The returned now() has a reset() for loading another video into the same player.
export function initPlayer(root, onended) {
  const v = root.querySelector("video");
  let total = Number(root.dataset.duration);
  if (!v || !(total > 0)) return; // no known duration (e.g. live): keep native controls
  const $ = (s) => root.querySelector(s);
  const bar = $(".bar"), pp = $(".pp"), time = $(".time"), vol = $(".vol"), fs = $(".fs");
  let base = Number(root.dataset.start) || 0; // stream offset in seconds
  let dragging = false;

  const fmt = (s) => {
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${x}` : `${m}:${x}`;
  };
  const now = () => base + v.currentTime;
  const buffered = (rel) => {
    for (let i = 0; i < v.buffered.length; i++) if (rel >= v.buffered.start(i) && rel <= v.buffered.end(i)) return true;
    return false;
  };
  const paint = () => {
    if (!dragging) bar.value = now();
    time.textContent = `${fmt(dragging ? bar.value : now())} / ${fmt(total)}`;
    pp.textContent = v.paused ? "▶" : "❚❚";
  };
  // A new stream from t (also what a quality change does: root.dataset.src is then the new quality's URL).
  const restart = (t) => {
    const paused = v.paused;
    base = Math.floor(t);
    if (paused) { // restarting must not start playback: the autoplay attribute would, until the new stream has loaded
      v.autoplay = false;
      v.addEventListener("loadeddata", () => (v.autoplay = true), { once: true });
    }
    v.src = `${root.dataset.src}&t=${base}`;
    if (!paused) v.play().catch(() => {});
    paint();
  };
  const seek = (t) => {
    t = Math.min(Math.max(0, t), total - 1);
    if (buffered(t - base)) v.currentTime = t - base;
    else restart(t);
    paint();
  };
  const toggle = () => (v.paused ? v.play().catch(() => {}) : v.pause());

  v.controls = false;
  $(".controls").hidden = false;
  bar.max = total;
  for (const e of ["timeupdate", "play", "pause", "seeked", "loadedmetadata"]) v.addEventListener(e, paint);
  bar.addEventListener("input", () => { dragging = true; paint(); });
  bar.addEventListener("change", () => { dragging = false; seek(Number(bar.value)); });
  pp.addEventListener("click", toggle);
  let tap = toggle; // speed.js swaps in a handler that tells a double tap from a single one
  v.addEventListener("click", (e) => tap(e));
  import("./speed.js").then((m) => m.speedControls({ root, v, seek, now, setTap: (f) => (tap = f), toggle })).catch(() => {});
  vol.addEventListener("input", () => (v.volume = Number(vol.value)));
  fs.addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen()));
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; // leave browser shortcuts (Alt+Left = back) alone
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return; // sliders and fields handle their own keys
    if (e.key === " " && e.target instanceof HTMLButtonElement) return; // native button activation
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft") seek(now() - 10);
    else if (e.key === "ArrowRight") seek(now() + 10);
  });
  v.addEventListener("ended", () => onended?.());
  now.restart = restart;
  now.reset = () => { // root.dataset.duration/start/src now describe a new video
    total = Number(root.dataset.duration);
    base = Number(root.dataset.start) || 0;
    bar.max = total;
    paint();
  };
  paint();
  return now; // current position in seconds, for progress reporting
}
