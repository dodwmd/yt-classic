// Masthead <datalist>: recent searches while the box is empty, server-fetched suggestions while typing (options are text only).
export function suggestions(box, get = (path, signal) => fetch(path, { signal }).then((r) => r.json())) {
  if (!box) return;
  const list = document.createElement("datalist");
  let recent, timer, ctl;
  list.id = "q-list";
  box.setAttribute("list", list.id);
  box.after(list);
  const fill = (items = []) => list.replaceChildren(...items.slice(0, 8).map((value) => Object.assign(document.createElement("option"), { value })));
  const show = () => {
    const text = box.value.trim();
    ctl?.abort();
    clearTimeout(timer);
    timer = setTimeout(async () => {
      ctl = new AbortController();
      try {
        if (text) fill((await get(`/api/search/suggest?q=${encodeURIComponent(text)}`, ctl.signal)).suggestions);
        else fill((recent ??= (await get("/api/searches", ctl.signal)).searches.map((s) => s.query)));
      } catch {
        recent = text ? recent : undefined; // aborted by a newer keystroke, or unavailable: keep what is shown
      }
    }, text ? 250 : 0);
  };
  box.addEventListener("focus", show);
  box.addEventListener("input", show);
  show(); // loaded on the first focus, which has already happened
}
