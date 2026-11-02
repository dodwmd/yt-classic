// Playback speed, double-tap seek and their keyboard shortcuts. Loaded lazily by player.js (not part of a page's eager budget).
export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const STEP = 10; // seconds per double-tap
export const TAP_MS = 300; // two taps within this are a double tap
export const ACC_MS = 700; // consecutive double taps within this add up; the seek happens once they stop

// A stored or typed rate that is not one of the offered speeds falls back to normal speed.
export const clampRate = (r) => (SPEEDS.includes(Number(r)) ? Number(r) : 1);
// Left third rewinds, right third forwards, the middle is just play/pause. frac: 0..1 across the video.
export const zone = (frac) => (frac < 1 / 3 ? -1 : frac > 2 / 3 ? 1 : 0);

// Taps on the same side within TAP_MS of each other: the second one returns true (and the pair is used up).
export function doubleTap() {
  let last = null;
  return (z, t) => {
    const hit = last !== null && last.z === z && t - last.t <= TAP_MS;
    last = hit ? null : { z, t };
    return hit;
  };
}

// Consecutive double taps on one side add up (YouTube-style) until the seek timer ends the run: while a run is open every
// further tap on that side adds a step. A tap on the other side starts the total over.
export function accumulator() {
  let run = null;
  return {
    add(z, from) {
      if (!run) run = { from, d: 0, z };
      if (run.z !== z) { run.z = z; run.d = 0; }
      run.d += z * STEP;
      return run;
    },
    open: (z) => run !== null && run.z === z,
    finish() { run = null; },
  };
}

// Keys typed into a field, or composed by an IME, are not shortcuts.
export const typing = (e) => e.isComposing || !!e.target?.matches?.("input,select,textarea,[contenteditable]");

export function speedControls({ root, v, seek, now, setTap, toggle }) {
  const sel = document.createElement("select");
  sel.className = "spd";
  sel.setAttribute("aria-label", "Playback speed");
  for (const s of SPEEDS) {
    const o = document.createElement("option");
    o.value = String(s);
    o.textContent = `${s}×`;
    sel.append(o);
  }
  const fs = root.querySelector(".fs");
  fs.before(sel);

  let rate = 1;
  try { rate = clampRate(localStorage.getItem("yt.rate")); } catch { /* storage blocked: stay at 1× */ }
  // The remux restarts on every seek and the media element resets playbackRate to defaultPlaybackRate when it
  // loads a new source, so both are set, and loadedmetadata reapplies in case a browser disagrees.
  const apply = () => { v.defaultPlaybackRate = v.playbackRate = rate; sel.value = String(rate); };
  const setRate = (r) => {
    rate = clampRate(r);
    apply();
    try { localStorage.setItem("yt.rate", String(rate)); } catch { /* ignore */ }
  };
  apply();
  v.addEventListener("loadedmetadata", apply);
  sel.addEventListener("change", () => setRate(sel.value));
  // A mouse-picked option must not keep the keyboard (Space, arrows); a keyboard user stays on the select.
  sel.addEventListener("change", () => { setRate(sel.value); if (!sel.matches?.(":focus-visible")) sel.blur(); say(`Speed ${rate}×`); });
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey || typing(e)) return;
    const i = SPEEDS.indexOf(rate) + (e.key === ">" ? 1 : e.key === "<" ? -1 : 0);
    if ((e.key === ">" || e.key === "<") && i >= 0 && i < SPEEDS.length) { setRate(SPEEDS[i]); say(`Speed ${rate}×`); }
  });

  // Double tap on the left or right third seeks. Touch: the single tap still toggles play/pause, but on the sides it
  // waits TAP_MS to be sure. Mouse: a click toggles at once and the native dblclick seeks.
  const fx = document.createElement("div"), st = document.createElement("div");
  fx.className = "tapfx";
  fx.setAttribute("aria-hidden", "true");
  fx.hidden = true;
  st.className = "vh"; // always rendered, so screen readers pick up changes to it
  st.setAttribute("role", "status");
  root.append(fx, st);
  function say(text) { st.textContent = text; }
  const isDouble = doubleTap(), run = accumulator();
  let single = 0, fxTimer = 0, seekTimer = 0, touchAt = -1e9;
  const sideOf = (e) => {
    const r = v.getBoundingClientRect();
    return zone(r.width > 0 ? (e.clientX - r.left) / r.width : 0.5);
  };
  const step = (z) => {
    const r = run.add(z, now());
    fx.textContent = `${r.d > 0 ? "+" : ""}${r.d}s`;
    fx.className = z < 0 ? "tapfx l" : "tapfx r";
    fx.hidden = false;
    say(`${z < 0 ? "Rewind" : "Forward"} ${Math.abs(r.d)} seconds`);
    clearTimeout(fxTimer);
    fxTimer = setTimeout(() => (fx.hidden = true), ACC_MS);
    clearTimeout(seekTimer);
    seekTimer = setTimeout(() => { run.finish(); seek(r.from + r.d); }, ACC_MS);
  };
  setTap((e) => {
    const z = sideOf(e), touch = e.pointerType === "touch" || e.pointerType === "pen";
    clearTimeout(single);
    if (z === 0 || !touch) return toggle();
    touchAt = e.timeStamp;
    if (isDouble(z, e.timeStamp) || run.open(z)) return step(z);
    single = setTimeout(toggle, TAP_MS);
  });
  v.addEventListener("dblclick", (e) => {
    const z = sideOf(e);
    if (z && e.timeStamp - touchAt > 1000) step(z); // a touch double tap is handled above
  });
}
