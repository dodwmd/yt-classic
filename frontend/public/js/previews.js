// Scrub previews: a storyboard thumbnail above the seek bar while the pointer hovers or drags on it. Loaded lazily by speed.js on
// the first pointer over the bar. Images come from our own /api/video/:id/storyboard/:n.jpg only; decoration (aria-hidden).
import { formatSeconds } from "./fmt.js";
import { api } from "./lib.js";

export const MAX_W = 160;
export const THUMB = 8; // the native slider thumb's radius: the track runs from bar.left + THUMB to bar.right - THUMB // displayed tile width; wider storyboard tiles are scaled down

// Which sheet, column and row show second t. Past the end shows the last tile; tiles = the server's descriptor.
export function locate(t, { cols, rows, count, interval }) {
  const i = Math.min(Math.max(0, Math.floor(t / interval) || 0), count - 1), per = cols * rows, k = i % per;
  return { sheet: Math.floor(i / per), col: k % cols, row: Math.floor(k / cols) };
}

export const valid = (t) => !!t && ["w", "h", "cols", "rows", "count", "interval"].every((k) => Number.isFinite(t[k]) && t[k] > 0);
export const sheetUrl = (id, n) => `/api/video/${id}/storyboard/${n}.jpg`;

export function previews(root, bar) {
  const pv = document.createElement("div"), img = document.createElement("div"), lab = document.createElement("div");
  pv.className = "pv";
  pv.hidden = true;
  pv.setAttribute("aria-hidden", "true");
  img.className = "pvi";
  lab.className = "pvt";
  pv.append(img, lab);
  root.append(pv);
  const known = new Map(), seen = new Set(); // video id -> descriptor | null (none) | undefined (loading); sheet urls already requested
  let last;
  const idOf = () => /^\/stream\/([\w-]{11})\?/.exec(root.dataset.src ?? "")?.[1];
  const begin = () => {
    const id = idOf();
    if (!id || known.has(id)) return;
    known.set(id, undefined);
    api(`/api/video/${id}/storyboard`).then((r) => known.set(id, valid(r.tiles) ? r.tiles : null), (e) => (e.code === "no-storyboard" ? known.set(id, null) : known.delete(id)));
  };
  const show = (e) => {
    const id = idOf(), total = Number(root.dataset.duration);
    if (id !== last) { // another video in the same player (TV): drop the old tile and look the new one up
      last = id;
      hide();
      begin();
    }
    const tiles = id && known.get(id);
    if (!tiles || !(total > 0)) return;
    const b = bar.getBoundingClientRect(), r = root.getBoundingClientRect();
    if (!(b.width > 2 * THUMB)) return;
    const t = Math.min(Math.max((e.clientX - b.left - THUMB) / (b.width - 2 * THUMB), 0), 1) * total;
    const { sheet, col, row } = locate(t, tiles), url = sheetUrl(id, sheet), s = Math.min(1, MAX_W / tiles.w);
    const w = Math.round(tiles.w * s), h = Math.round(tiles.h * s);
    if (!seen.has(url)) { seen.add(url); new Image().src = url; }
    const st = img.style;
    st.width = `${w}px`;
    st.height = `${h}px`;
    st.backgroundImage = `url("${url}")`;
    st.backgroundSize = `${tiles.cols * w}px ${tiles.rows * h}px`;
    st.backgroundPosition = `${-col * w}px ${-row * h}px`;
    const chapter = root.chapters?.findLast?.((c) => c.start <= t)?.title;
    lab.textContent = chapter ? `${formatSeconds(t)} ${chapter}` : formatSeconds(t);
    pv.style.maxWidth = `${w + 4}px`;
    pv.style.left = `${Math.min(Math.max(e.clientX - r.left - (w + 4) / 2, 0), Math.max(0, r.width - w - 4))}px`;
    pv.style.bottom = `${r.bottom - b.top + 6}px`;
    pv.hidden = false;
  };
  const hide = () => (pv.hidden = true);
  last = idOf();
  begin();
  for (const t of ["pointerenter", "pointerdown"]) bar.addEventListener(t, begin);
  bar.addEventListener("pointermove", show);
  for (const t of ["pointerleave", "pointercancel"]) bar.addEventListener(t, hide);
  bar.addEventListener("pointerup", (e) => e.pointerType !== "mouse" && hide());
}
