import { $, api, clone, historyCard, run, setTitle } from "./lib.js";

// Two views on one page: /playlists (all lists) and /playlists?id=N (one list). Plain order: no auto-advance anywhere.
const id = new URLSearchParams(location.search).get("id");
const form = { "content-type": "application/x-www-form-urlencoded" };
const shown = new Set();
let next;
let busy = false;

// One request at a time; a failure is shown at the top of the page.
async function attempt(request) {
  if (busy) return;
  busy = true;
  $("#err").hidden = true;
  try {
    await request();
  } catch (err) {
    $("#err").textContent = err.message || String(err);
    $("#err").hidden = false;
  }
  busy = false;
}
const send = (path, method, fields) => api(path, { method, headers: form, body: fields && new URLSearchParams(fields) });

function row(p) {
  const li = clone("t-pl");
  const name = $(".name", li);
  name.textContent = p.name;
  name.href = `/playlists?id=${p.id}`;
  $(".count", li).textContent = `${p.count} video${p.count === 1 ? "" : "s"}`;
  for (const b of [$(".ren", li), $(".del", li)]) {
    b.hidden = p.builtin;
    b.setAttribute("aria-label", `${b.textContent} ${p.name}`);
  }
  $(".ren", li).addEventListener("click", () => {
    const to = prompt("Rename playlist", name.textContent);
    if (to && to.trim() !== name.textContent) attempt(async () => (name.textContent = (await send(`/api/playlists/${p.id}/rename`, "POST", { name: to })).playlist.name));
  });
  $(".del", li).addEventListener("click", () => confirm(`Delete the playlist "${name.textContent}" and its list of videos? The videos themselves are not affected.`) && attempt(async () => {
    await send(`/api/playlists/${p.id}`, "DELETE");
    li.remove();
  }));
  return li;
}

function showLists() {
  setTitle("Playlists");
  $("#lists").hidden = false;
  $("#pl-new").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt(async () => {
      $("#pl-list").append(row((await send("/api/playlists", "POST", { name: $("#new-name").value })).playlist));
      $("#new-name").value = "";
    });
  });
  return api("/api/playlists").then(({ playlists }) => $("#pl-list").append(...playlists.map(row)));
}

const first = () => $("#pl-grid .thumb")?.getAttribute("href");
function sync() {
  $("#none").hidden = !!$("#pl-grid").children.length;
  $("#play").hidden = !first();
  $("#play").href = first() || "/playlists";
}

async function load() {
  await attempt(async () => {
    const page = await api(`/api/playlists/${id}?limit=48${next ? `&before=${encodeURIComponent(next)}` : ""}`);
    next = page.next;
    $("#pl-title").textContent = page.playlist.name;
    setTitle(page.playlist.name);
    for (const v of page.items) {
      if (shown.has(v.id)) continue;
      shown.add(v.id);
      const card = historyCard({ ...v, position: 0 }, "");
      const btns = document.createElement("div");
      for (const [label, act] of [["Move to top", async () => {
        await send(`/api/playlists/${id}/move`, "POST", { id: v.id, index: 0 });
        $("#pl-grid").prepend(card);
      }], ["Remove", async () => {
        await send(`/api/playlists/${id}/items/${v.id}`, "DELETE");
        shown.delete(v.id);
        card.remove();
      }]]) {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.setAttribute("aria-label", `${label}: ${v.title}`);
        b.addEventListener("click", () => attempt(act).then(sync));
        btns.append(b);
      }
      card.append(btns);
      $("#pl-grid").append(card);
    }
    $("#more").hidden = !next;
    sync();
  });
}

run(async () => {
  if (!id) return showLists();
  if (!/^[1-9]\d{0,8}$/.test(id)) throw new Error("No such playlist.");
  $("#list").hidden = false;
  await load();
  $("#more").addEventListener("click", load);
});
