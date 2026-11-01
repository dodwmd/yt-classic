import { $, api, cardNode, channelHref, clone, historyCard, markWatched, run, setTitle, thumbUrl } from "./lib.js";
import { formatSeconds, formatViews, join, timeAgo } from "./fmt.js";

const form = { "content-type": "application/x-www-form-urlencoded" };
const box = { hideWatched: "#f-watched", shorts: "#f-shorts", live: "#f-live" };

/**
 * Feed paging. Only the latest request may paint (quick toggling cannot interleave), Load more does nothing while a
 * request runs or without a cursor, and a failed filter change drops the old cursor (it belongs to other filters).
 * fetchPage(before) resolves {items, next}; paint(state) draws; both are injected so the tests can drive it.
 */
export function feedController({ fetchPage, paint, next }) {
  let seq = 0, busy = false;
  return {
    get next() { return next; },
    async load(append) {
      if (append && (busy || !next)) return;
      const mine = ++seq;
      busy = true;
      paint({ busy: true, append, next });
      try {
        const page = await fetchPage(append ? next : undefined);
        if (mine !== seq) return;
        next = page.next;
        paint({ busy: false, append, items: page.items, next });
      } catch (err) {
        if (mine !== seq) return;
        if (!append) next = undefined;
        paint({ busy: false, append, error: err.message || "Failed", next });
      } finally {
        if (mine === seq) busy = false;
      }
    },
  };
}

// The query for the feed as the filter bar shows it (explicit, so a stale saved preference can never disagree with the screen).
const query = () => new URLSearchParams({
  channel: $("#f-channel").value, hideWatched: +$("#f-watched").checked, shorts: $("#f-shorts").checked ? "hide" : "show", live: $("#f-live").checked ? "hide" : "show",
});

function addCards(items) {
  for (const v of items) {
    $("#feed-grid").append(cardNode({
      id: v.id, title: v.title, tooltip: v.description, thumb: thumbUrl(v.id), duration: v.durationSeconds && formatSeconds(v.durationSeconds),
      channelId: v.channelId, channelTitle: v.channelTitle,
      meta: join(v.live ? "Live" : "", formatViews(v.views), timeAgo(v.publishedAt)),
    }));
  }
  markWatched();
}

// aria-disabled, not disabled: the button keeps keyboard focus while it works.
function paint({ busy, append, items, next, error }) {
  const more = $("#more");
  more.setAttribute("aria-disabled", busy);
  $("#feed-err").textContent = error || "";
  $("#feed-err").hidden = !error;
  if (!busy) more.hidden = !next;
  if (!items) return;
  if (!append) $("#feed-grid").replaceChildren();
  const before = $("#feed-grid").childElementCount;
  addCards(items);
  const msg = $("#feed-msg");
  msg.textContent = !$("#feed-grid").childElementCount ? "Nothing matches these filters." : append ? `${$("#feed-grid").childElementCount - before} more videos loaded.` : "";
  msg.hidden = !msg.textContent;
}

let saving = Promise.resolve();
// Saved for the next visit and for the other client, one request after another so the last change wins; a failure
// leaves the filter on screen working for this visit.
const save = (body) => (saving = saving.then(() => api("/api/prefs", { method: "POST", headers: form, body: new URLSearchParams(body) }).catch(() => {})));

if (document.getElementById("home")) run(async () => {
  setTitle("Home");
  const { subs, feed, next: more, prefs, continue: resume } = await api("/api/home");
  if (!subs.length && !resume.length) {
    $("#empty").hidden = false;
    return;
  }
  $("#home").hidden = false;
  $("#cont").hidden = !resume.length;
  for (const h of resume) $("#cont-grid").append(historyCard(h, `${formatSeconds(h.position)} watched`));
  for (const [k, sel] of Object.entries(box)) $(sel).checked = prefs[k] === "hide" || prefs[k] === true;
  const feedCtl = feedController({ fetchPage: (before) => { const q = query(); if (before) q.set("before", before); return api(`/api/feed?${q}`); }, paint, next: more });
  paint({ busy: false, append: false, items: feed, next: more });
  for (const s of subs) {
    const li = clone("t-sub");
    const a = $("a", li);
    a.textContent = s.title;
    a.href = channelHref(s.id);
    $("#subs-list").append(li);
    const o = document.createElement("option");
    o.value = s.id;
    o.textContent = s.title;
    $("#f-channel").append(o);
  }
  $("#f-channel").addEventListener("change", () => feedCtl.load(false));
  for (const [k, sel] of Object.entries(box)) {
    $(sel).addEventListener("change", (e) => {
      const on = e.target.checked;
      feedCtl.load(false);
      save({ [k]: k === "hideWatched" ? +on : on ? "hide" : "show" });
    });
  }
  $("#more").addEventListener("click", () => feedCtl.load(true));
});
