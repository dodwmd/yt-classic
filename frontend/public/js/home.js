import { $, api, cardNode, channelHref, clone, markWatched, pctOf, run, setTitle, thumbUrl } from "./lib.js";
import { formatSeconds, formatViews, join, timeAgo } from "./fmt.js";

run(async () => {
  setTitle("Home");
  const { subs, feed, continue: resume } = await api("/api/home");
  if (!subs.length && !resume.length) {
    $("#empty").hidden = false;
    return;
  }
  $("#home").hidden = false;
  $("#cont").hidden = !resume.length;
  for (const h of resume) {
    $("#cont-grid").append(cardNode({
      id: h.id, title: h.title, thumb: thumbUrl(h.id), duration: h.durationSeconds && formatSeconds(h.durationSeconds),
      channelId: h.channelId, channelTitle: h.channelTitle, pct: pctOf(h), meta: `${formatSeconds(h.position)} watched`,
    }));
  }
  for (const v of feed) {
    $("#feed-grid").append(cardNode({
      id: v.id, title: v.title, tooltip: v.description, thumb: thumbUrl(v.id),
      channelId: v.channelId, channelTitle: v.channelTitle,
      meta: join(formatViews(v.views), timeAgo(v.publishedAt)),
    }));
  }
  for (const s of subs) {
    const li = clone("t-sub");
    const a = $("a", li);
    a.textContent = s.title;
    a.href = channelHref(s.id);
    $("#subs-list").append(li);
  }
  markWatched();
});
