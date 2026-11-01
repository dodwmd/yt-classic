import { $, api, cardNode, run, safeImg, setTitle, thumbUrl } from "./lib.js";
import { timeAgo } from "./fmt.js";

const id = decodeURIComponent(location.pathname.split("/")[2] ?? "");
const token = new URLSearchParams(location.search).get("pageToken") ?? "";

run(async () => {
  const query = token ? `?${new URLSearchParams({ pageToken: token })}` : "";
  const { channel: c, page, subscribed } = await api(`/api/channel/${encodeURIComponent(id)}${query}`);

  setTitle(c.title);
  $("#channel").hidden = false;
  $("#name").textContent = c.title;
  $("#avatar").src = safeImg(c.thumb);
  $("#about").textContent = c.description;
  if (safeImg(c.banner)) {
    $("#banner").src = `${c.banner}=w1060`;
    $("#banner").hidden = false;
  }

  const button = $("#sub-btn");
  let on = subscribed;
  const paint = () => (button.textContent = on ? "Unsubscribe" : "Subscribe");
  paint();
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const res = await api(`/api/${on ? "unsubscribe" : "subscribe"}`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ id }),
      });
      on = res.subscribed;
      paint();
    } catch (err) {
      button.textContent = err.message;
    } finally {
      button.disabled = false;
    }
  });

  for (const v of page.items) {
    $("#uploads").append(cardNode({ id: v.id, title: v.title, thumb: v.thumb || thumbUrl(v.id), meta: timeAgo(v.publishedAt) }));
  }
  for (const [name, tok] of [["prev", page.prevPageToken], ["next", page.nextPageToken]]) {
    if (!tok) continue;
    $(`#${name}`).href = `/channel/${encodeURIComponent(id)}?${new URLSearchParams({ pageToken: tok })}`;
    $(`#${name}`).hidden = false;
  }
});
