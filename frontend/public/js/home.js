import { $, api, cardNode, channelHref, clone, historyCard, markWatched, run, setTitle, thumbUrl } from "./lib.js";
import { formatSeconds, formatViews, join, timeAgo } from "./fmt.js";

const form = { "content-type": "application/x-www-form-urlencoded" };
const box = { hideWatched: "#f-watched", shorts: "#f-shorts", live: "#f-live" };
let next, seq = 0;

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

function show(items, more, append) {
  if (!append) $("#feed-grid").replaceChildren();
  addCards(items);
  next = more;
  $("#more").hidden = !more;
  $("#feed-msg").hidden = !!$("#feed-grid").childElementCount;
  $("#feed-msg").textContent = $("#feed-msg").hidden ? "" : "Nothing matches these filters.";
}

// Fetches a page (the first, or the one after `next`); only the latest request may paint, so quick toggling cannot interleave.
async function load(append) {
  const mine = ++seq, q = query(), more = $("#more");
  if (append) q.set("before", next);
  more.disabled = true;
  try {
    const page = await api(`/api/feed?${q}`);
    if (mine === seq) show(page.items, page.next, append);
  } catch (err) {
    if (mine === seq) { $("#feed-msg").textContent = err.message || "Failed"; $("#feed-msg").hidden = false; }
  }
  if (mine === seq) more.disabled = false;
}

run(async () => {
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
  show(feed, more, false);
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
  $("#f-channel").addEventListener("change", () => load(false));
  for (const [k, sel] of Object.entries(box)) {
    $(sel).addEventListener("change", (e) => {
      const on = e.target.checked;
      load(false);
      // Saved for the next visit and for the other client; a failure leaves the filter on screen working for this visit.
      api("/api/prefs", { method: "POST", headers: form, body: new URLSearchParams({ [k]: k === "hideWatched" ? +on : on ? "hide" : "show" }) }).catch(() => {});
    });
  }
  $("#more").addEventListener("click", () => load(true));
});
