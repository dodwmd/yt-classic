// Captions overlay (lazy, imported by watch.js, which ignores a failure to load it: then there is simply no CC button). The stream restarts at ?t= on every seek, so video.currentTime is relative:
// cues are matched against now() (base + currentTime, the seek bar's absolute time), which rules out <track>. Text-only output.
import { api } from "./lib.js";

const secs = (s) => {
  const m = /^(?:(\d+):)?([0-5]?\d):([0-5]\d)[.,](\d{1,3})$/.exec(s);
  return m ? (m[1] || 0) * 3600 + m[2] * 60 + +m[3] + m[4].padEnd(3, "0") / 1000 : NaN;
};
// Only real WebVTT tags go (<c.x>, </c>, <v Bob>, <00:00:01.000>); a stray "<" in the text stays.
const VTT_TAG = /^(?:\/?(?:c|v|i|b|u|lang|ruby|rt)(?:[. ][^<>]*)?|\d\d?:[\d:.]+)$/i;
// A linear scan, repeated until nothing more goes (removing one tag can join the text around it into another).
const strip = (t) => {
  for (let prev = ""; prev !== t;) {
    prev = t;
    let out = "", at = 0;
    for (let lt = t.indexOf("<"); lt >= 0; lt = t.indexOf("<", at)) {
      const gt = t.indexOf(">", lt);
      if (gt < 0) break;
      const real = VTT_TAG.test(t.slice(lt + 1, gt));
      out += t.slice(at, real ? lt : lt + 1);
      at = real ? gt + 1 : lt + 1;
    }
    t = out + t.slice(at);
  }
  return t;
};
const ENT = { amp: "&", lt: "<", gt: ">", nbsp: " ", quot: '"', apos: "'" };
const decode = (t) => t.replace(/&(?:#(x[\da-f]+|\d+)|(amp|lt|gt|nbsp|quot|apos));/gi, (m, n, w) => {
  if (w) return ENT[w.toLowerCase()];
  const c = Number(n[0] === "x" || n[0] === "X" ? `0${n}` : n);
  return c > 31 && c < 0x110000 && !(c >= 0xd800 && c < 0xe000) ? String.fromCodePoint(c) : "";
});

// WebVTT to [{s, e, t}] by start. [auto]: automatic captions roll, repeating the previous cue's lines, so those are dropped
// and only the last two lines are kept; manual cues keep every line as written.
export function parseVtt(text, auto = false) {
  const cues = [];
  let prev = [];
  for (const block of text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split(/\n{2,}/)) {
    const lines = block.split("\n"), i = lines.findIndex((l) => l.includes("-->"));
    if (i < 0 || i > 1 || /^(NOTE|STYLE|REGION)\b/.test(lines[0])) continue;
    const [a, b] = lines[i].split("-->"), s = secs(a.trim()), e = secs(b.trim().split(/\s/)[0]);
    if (!(e > s)) continue;
    const all = lines.slice(i + 1).map((l) => decode(strip(l)).replace(/\s+/g, " ").trim()).filter(Boolean);
    const t = (auto ? all.filter((l) => !prev.includes(l)).slice(-2) : all.slice(0, 6)).map((l) => l.slice(0, 160)).join("\n");
    prev = all;
    if (t) cues.push({ s, e, t });
  }
  return cues.sort((x, y) => x.s - y.s);
}

// Text at absolute time [t]: binary search for the last cue started, then back through the cues that could still be showing
// (m[i] is the latest end among cues 0..i, so a long cue early in the list is not missed behind many short ones).
export function activeAt(cues, t) {
  if (!cues.m) { let m = 0; cues.m = cues.map((c) => (m = Math.max(m, c.e))); }
  let lo = 0, hi = cues.length;
  while (lo < hi) { const k = (lo + hi) >> 1; if (cues[k].s <= t) lo = k + 1; else hi = k; }
  const out = [];
  for (let i = lo - 1; i >= 0 && cues.m[i] > t && out.length < 3; i--) if (cues[i].e > t) out.unshift(cues[i].t);
  return out.join("\n").split("\n").slice(-4).join("\n");
}

const store = (k, v) => { try { return v === undefined ? localStorage.getItem(k) : localStorage.setItem(k, v); } catch { return null; } };

export function subtitles(root, now, id) {
  const video = root.querySelector("video");
  // The CC button is always there; the track list is only asked for when captions are first turned on (or were left on).
  const mk = (tag, cls) => Object.assign(document.createElement(tag), { className: cls });
  const btn = mk("button", "cc"), sel = mk("select", "cclang"), box = mk("div", "ccbox");
  btn.type = "button";
  btn.textContent = "CC";
  btn.setAttribute("aria-label", "Subtitles");
  sel.setAttribute("aria-label", "Subtitle language");
  box.setAttribute("aria-hidden", "true");
  let lang = store("yt.cc.lang") || "", on = store("yt.cc") === "1", tracks = null, cues = [], gen = 0, msg = "";

  const show = () => { box.textContent = msg || (on ? activeAt(cues, now()) : ""); box.hidden = !box.textContent; };
  const sync = () => { btn.setAttribute("aria-pressed", String(on)); sel.hidden = !on || !tracks || tracks.length < 2; sel.value = lang; show(); };
  async function haveTracks() {
    if (!tracks) {
      const r = await api(`/api/video/${encodeURIComponent(id)}/subs?pref=${encodeURIComponent(lang)}`);
      tracks = r.tracks ?? [];
      for (const t of tracks) sel.append(Object.assign(document.createElement("option"), { value: t.lang, textContent: t.auto ? `${t.name} (auto)` : t.name }));
      if (!tracks.some((t) => t.lang === lang)) lang = (tracks.find((t) => !t.auto) ?? tracks[0])?.lang ?? "";
    }
    if (!tracks.length) throw new Error("No subtitles for this video");
  }
  async function load() {
    const mine = ++gen;
    cues = [];
    if (on) {
      try {
        await haveTracks();
        const res = await fetch(`/api/video/${encodeURIComponent(id)}/subs/${encodeURIComponent(lang)}.vtt`);
        if (!res.ok) throw new Error(res.status === 404 ? "No subtitles in that language" : "Subtitles unavailable");
        const text = await res.text();
        if (mine === gen) cues = parseVtt(text, tracks.find((t) => t.lang === lang).auto);
      } catch (e) {
        if (mine !== gen) return;
        on = false; // not saved: it may work next time
        msg = e.message.startsWith("No ") ? e.message : "Subtitles unavailable";
        setTimeout(() => { msg = ""; sync(); }, 3000);
      }
    }
    sync();
  }
  const toggle = () => { on = !on; store("yt.cc", on ? "1" : "0"); msg = ""; load(); };
  btn.addEventListener("click", toggle);
  sel.addEventListener("change", () => { lang = sel.value; store("yt.cc.lang", lang); load(); });
  for (const e of ["timeupdate", "seeked", "loadedmetadata", "play", "pause"]) video.addEventListener(e, show);
  document.addEventListener("keydown", (e) => {
    if (e.key === "c" && !e.altKey && !e.ctrlKey && !e.metaKey && !e.isComposing && !e.target?.matches?.("input,select,textarea,[contenteditable]")) toggle();
  });
  root.querySelector(".fs").before(btn, sel);
  root.append(box);
  sync();
  if (on) load();
}
