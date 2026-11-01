import { $, api, cardNode, channelHref, clone, run, setTitle, thumbUrl } from "./lib.js";
import { formatViews, join, timeAgo } from "./fmt.js";

run(async () => {
  setTitle("Home");
  const { subs, feed } = await api("/api/home");
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
  for (const s of subs) {
    const li = clone("t-sub");
    const a = $("a", li);
    a.textContent = s.title;
    a.href = channelHref(s.id);
    $("#subs-list").append(li);
  }
});
