// Quality menu for the watch page (lazy). Choosing a tier or Auto restarts the stream in place.
// Probes: real codec strings (VP9/AV1 at the 4K level) with AAC audio.
const TYPES = { avc1: "avc1.640028", vp9: "vp09.00.51.08", av1: "av01.0.13M.08" };

// decoders this browser claims, and the screen's shorter side in device pixels
export function caps() {
  const v = document.createElement("video");
  const have = Object.keys(TYPES).filter((c) => v.canPlayType(`video/mp4; codecs="${TYPES[c]}, mp4a.40.2"`));
  return { codecs: (have.length ? have : ["avc1"]).join(","), maxh: Math.round(Math.min(screen.width, screen.height) * (devicePixelRatio || 1)) };
}

// adds the remembered quality (and for Auto or above 1080p the caps) to the /api/video query; returns the caps or null
export function prefs(query) {
  try { if (!query.has("q") && localStorage.getItem("yt.q")) query.set("q", localStorage.getItem("yt.q")); } catch { /* storage blocked */ }
  const q = query.get("q");
  if (q !== "auto" && !(q > 1080)) return null;
  const c = caps();
  for (const k in c) query.set(k, c[k]);
  return c;
}

// tiers whose codecs (per tier, from the server) the browser all lacks are hidden
export const playable = (qualities, codecs, have) => qualities.filter((h) => !(codecs[h] || []).length || codecs[h].some((c) => have.includes(c)));
export const autoTier = (tiers, maxh) => tiers.filter((h) => h <= Math.max(maxh, 360)).pop() ?? tiers[0];

export function qualityMenu({ res: { video: { id }, lang, quality, auto, qualities, codecs, tiersKnown }, query, stream, player, ready, restart, now }) {
  const c = caps(), have = c.codecs.split(",");
  let tiers = playable(qualities, codecs, have), cur = auto ? "auto" : quality;
  const box = document.getElementById("quality");
  const href = (q) => `/watch?v=${encodeURIComponent(id)}&q=${q}${lang ? `&a=${encodeURIComponent(lang)}` : ""}`;
  const mark = () => { // in place, so a focused link keeps focus; a remembered tier the video lacks marks the best one below it
    const on = String(cur === "auto" ? cur : tiers.filter((h) => h <= cur).pop() ?? cur);
    for (const el of box.querySelectorAll("a")) {
      if (el.dataset.q === on) el.setAttribute("aria-current", "true");
      else el.removeAttribute("aria-current");
    }
  };
  const draw = () => {
    const had = box.contains(document.activeElement) && document.activeElement.dataset.q;
    box.replaceChildren();
    for (const q of [...tiers, "auto"]) {
      if (box.firstChild) box.append(" · ");
      const el = document.createElement("a");
      el.textContent = q === "auto" ? "Auto (max for screen)" : `${q}p`;
      el.dataset.q = String(q);
      el.href = href(q);
      el.addEventListener("click", (e) => {
        if (!ready()) return; // no custom player (live, or not started): the link reloads the page
        e.preventDefault();
        choose(q);
      });
      box.append(el);
    }
    mark();
    if (had) box.querySelector(`[data-q="${had}"]`)?.focus();
  };
  function choose(q) {
    cur = q;
    try { localStorage.setItem("yt.q", q); } catch { /* only this page remembers */ }
    const at = Math.floor(now());
    player.dataset.src = stream(q === "auto" ? autoTier(tiers, c.maxh) : q, c.codecs);
    history.replaceState(null, "", href(q) + (at > 0 ? `&t=${at}` : ""));
    mark();
    restart(at);
  }
  draw();
  // the page data has the usual tiers; this video's real ones come separately
  if (!tiersKnown) {
    fetch(`/api/video/${encodeURIComponent(id)}/qualities?${query}`).then((r) => (r.ok ? r.json() : null)).then((b) => {
      if (b?.tiersKnown) { tiers = playable(b.qualities, b.codecs, have); draw(); }
    }).catch(() => {});
  }
}
