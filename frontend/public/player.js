// Seek bar for live-remuxed streams. A plain <video> can't seek these (unknown length/byte layout),
// so we show the real duration (from the API) and restart the stream at ?t= when seeking outside the buffer.
(() => {
  const root = document.getElementById("player");
  const v = root && root.querySelector("video");
  const total = root ? Number(root.dataset.duration) : 0;
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
  const seek = (t) => {
    t = Math.min(Math.max(0, t), total - 1);
    if (buffered(t - base)) v.currentTime = t - base;
    else {
      base = Math.floor(t);
      v.src = `${root.dataset.src}&t=${base}`;
      v.play().catch(() => {});
    }
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
  v.addEventListener("click", toggle);
  vol.addEventListener("input", () => (v.volume = Number(vol.value)));
  fs.addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : root.requestFullscreen()));
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return; // leave browser shortcuts (Alt+Left = back) alone
    if (e.target instanceof HTMLInputElement) return; // sliders and fields handle their own keys
    if (e.key === " " && e.target instanceof HTMLButtonElement) return; // native button activation
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft") seek(now() - 10);
    else if (e.key === "ArrowRight") seek(now() + 10);
  });
  paint();
})();
