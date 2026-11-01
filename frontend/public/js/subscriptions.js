import { $, api, setTitle } from "./lib.js";

const MAX = 1024 * 1024;
const plural = (n, one) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "Added 3, 2 already subscribed. Skipped 1 invalid, 1 @handle (can't be resolved), 2 over the limit. 5 subscriptions now." */
function summary({ added, existing, skipped: s, total }) {
  const skipped = [s.invalid && `${s.invalid} invalid`, s.handles && `${s.handles} @handle (can't be resolved)`, s.full && `${s.full} over the limit of 500`].filter(Boolean);
  return `Added ${added}, ${existing} already subscribed.${skipped.length ? ` Skipped ${skipped.join(", ")}.` : ""} You now have ${plural(total, "subscription")}.`;
}

setTitle("Import / export subscriptions");
$("#import").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("#result");
  const go = $("#go");
  const file = $("#file").files[0];
  const pasted = $("#paste").value;
  if (file && file.size > MAX) return void (out.textContent = "That file is larger than 1 MB.");
  go.disabled = true;
  out.textContent = "Importing\u2026";
  try {
    // The raw bytes go to the server, which detects UTF-8/UTF-16; a chosen file wins over pasted text.
    const result = summary(await api("/api/subscriptions/import", { method: "POST", headers: { "content-type": "text/plain" }, body: file || pasted }));
    out.textContent = `${file && pasted.trim() ? `From the file ${file.name} (the pasted text was ignored). ` : ""}${result}`;
  } catch (err) {
    out.textContent = err.message;
  } finally {
    go.disabled = false;
  }
});
