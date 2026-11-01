import { $, api, cardNode, markWatched, pctOf, run, setTitle, thumbUrl } from "./lib.js";
import { formatSeconds, timeAgo } from "./fmt.js";

const post = (path, method = "POST") => api(path, { method });
let next;

async function load() {
  const { items, next: n } = await api(`/api/history?limit=48${next ? `&before=${next}` : ""}`);
  next = n;
  for (const h of items) {
    const card = cardNode({
      id: h.id, title: h.title, thumb: thumbUrl(h.id), duration: h.durationSeconds && formatSeconds(h.durationSeconds),
      channelId: h.channelId, channelTitle: h.channelTitle, pct: h.completed ? 0 : pctOf(h), meta: timeAgo(new Date(h.lastWatched).toISOString()),
    });
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rm";
    rm.textContent = "Remove";
    rm.setAttribute("aria-label", `Remove ${h.title} from history`);
    rm.addEventListener("click", async () => {
      await post(`/api/history/${h.id}`, "DELETE");
      card.remove();
      $("#none").hidden = !!$("#hist-grid").children.length;
    });
    card.append(rm);
    $("#hist-grid").append(card);
  }
  $("#more").hidden = n === undefined;
  $("#none").hidden = !!$("#hist-grid").children.length;
}

run(async () => {
  setTitle("History");
  await load();
  $("#history").hidden = false;
  markWatched();
  $("#more").addEventListener("click", () => load().then(markWatched));
  $("#clear").addEventListener("click", async () => {
    if (!confirm("Clear the whole watch history? This cannot be undone.")) return;
    await post("/api/history/clear");
    $("#hist-grid").replaceChildren();
    $("#more").hidden = true;
    $("#none").hidden = false;
  });
});
