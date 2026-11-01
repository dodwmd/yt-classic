import { $, api, historyCard, markWatched, run, setTitle } from "./lib.js";
import { timeAgo } from "./fmt.js";

const shown = new Set();
let next;
let busy = false;

async function attempt(request) {
  $("#err").hidden = true;
  try {
    await request();
  } catch (err) {
    $("#err").textContent = err.message || String(err);
    $("#err").hidden = false;
  }
}
const empty = () => ($("#none").hidden = !!$("#hist-grid").children.length);

async function load() {
  if (busy) return;
  busy = true;
  $("#more").disabled = true;
  await attempt(async () => {
    const page = await api(`/api/history?limit=48${next ? `&before=${encodeURIComponent(next)}` : ""}`);
    next = page.next;
    for (const h of page.items) {
      if (shown.has(h.id)) continue;
      shown.add(h.id);
      const card = historyCard(h, timeAgo(new Date(h.lastWatched).toISOString()));
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rm";
      rm.textContent = "Remove";
      rm.setAttribute("aria-label", `Remove ${h.title} from history`);
      rm.addEventListener("click", () => attempt(async () => {
        await api(`/api/history/${h.id}`, { method: "DELETE" });
        shown.delete(h.id);
        card.remove();
        empty();
      }));
      card.append(rm);
      $("#hist-grid").append(card);
    }
    $("#more").hidden = !next;
    empty();
  });
  $("#more").disabled = busy = false;
}

run(async () => {
  setTitle("History");
  $("#history").hidden = false;
  await load();
  markWatched();
  $("#more").addEventListener("click", () => load().then(markWatched));
  $("#clear").addEventListener("click", () => confirm("Clear the whole watch history? This cannot be undone.") && attempt(async () => {
    await api("/api/history/clear", { method: "POST" });
    shown.clear();
    next = undefined;
    $("#hist-grid").replaceChildren();
    $("#more").hidden = true;
    empty();
  }));
});
