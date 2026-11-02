// Quality menu for the watch page: loaded on demand. Choosing a quality (or Auto) restarts the stream in place.
const TYPES = { avc1: "avc1.640028", vp9: "vp09.00.40.08", av1: "av01.0.12M.08" };

// What this browser can decode and how tall the screen is in device pixels (shorter side: the video is landscape).
export function caps() {
  const v = document.createElement("video");
  const have = Object.keys(TYPES).filter((c) => v.canPlayType(`video/mp4; codecs="${TYPES[c]}"`));
  return { codecs: (have.length ? have : ["avc1"]).join(","), maxh: Math.round(Math.min(screen.width, screen.height) * (devicePixelRatio || 1)) };
}

// Tiers this browser can show for the video: all but those whose only codecs it lacks (the server lists them per tier).
export const playable = (qualities, codecs, have) => qualities.filter((h) => !(codecs[h] || []).length || codecs[h].some((c) => have.includes(c)));
// Auto: the tallest playable tier that fits the screen (at most 1080p unless a hardware-friendly codec above it is there).
export const autoTier = (tiers, maxh) => tiers.filter((h) => h <= Math.max(maxh, 360)).pop() ?? tiers[0];

export function qualityMenu({ id, lang, quality, auto, qualities, codecs, stream, player, ready, restart, now }) {
  const c = caps(), have = c.codecs.split(",");
  const tiers = playable(qualities, codecs, have);
  let cur = auto ? "auto" : tiers.filter((h) => h <= quality).pop() ?? quality;
  const box = document.getElementById("quality");
  const href = (q) => `/watch?v=${encodeURIComponent(id)}&q=${q}${lang ? `&a=${encodeURIComponent(lang)}` : ""}`;
  const draw = () => {
    box.replaceChildren();
    for (const q of [...tiers, "auto"]) {
      if (box.firstChild) box.append(" · ");
      const el = document.createElement(q === cur ? "b" : "a");
      el.textContent = q === "auto" ? "Auto" : `${q}p`;
      if (q !== cur) {
        el.href = href(q);
        el.addEventListener("click", (e) => {
          if (!ready()) return; // no custom player (live, or not started yet): the link reloads the page
          e.preventDefault();
          choose(q);
        });
      }
      box.append(el);
    }
  };
  function choose(q) {
    cur = q;
    try { localStorage.setItem("yt.q", q); } catch { /* storage blocked: only this page remembers */ }
    const at = now();
    player.dataset.src = stream(q === "auto" ? autoTier(tiers, c.maxh) : q);
    history.replaceState(null, "", href(q));
    draw();
    restart(at);
  }
  draw();
}
