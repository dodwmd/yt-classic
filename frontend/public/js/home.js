import { $, api, cardNode, channelHref, clone, run, setTitle, thumbUrl } from "./lib.js";
import { formatViews, join, timeAgo, viewsText } from "./fmt.js";

run(async () => {
  setTitle("Home");
  const { subs, feed, recs } = await api("/api/home");
  if (!subs.length) {
    $("#empty").hidden = false;
    return;
  }
  $("#home").hidden = false;
  for (const v of feed) {
    $("#feed-grid").append(cardNode({
      id: v.id, title: v.title, tooltip: v.description, thumb: thumbUrl(v.id),
      channelId: v.channelId, channelTitle: v.channelTitle,
      meta: join(formatViews(v.views), timeAgo(v.publishedAt)),
    }));
  }
  for (const r of recs) {
    $("#recs-grid").append(cardNode({
      id: r.id, title: r.title, thumb: r.thumb, duration: r.duration, channelTitle: r.channelTitle,
      meta: join(r.views && viewsText(r.views), r.age),
    }));
  }
  $("#recs").hidden = recs.length === 0;
  for (const s of subs) {
    const li = clone("t-sub");
    const a = $("a", li);
    a.textContent = s.title;
    a.href = channelHref(s.id);
    $("#subs-list").append(li);
  }
});
