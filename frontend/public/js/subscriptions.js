import { $, api } from "./lib.js";

$("#import").onsubmit = async (e) => {
  e.preventDefault();
  const out = $("#result"), go = $("#go");
  go.disabled = true;
  out.textContent = "Importing\u2026";
  try {
    out.textContent = (await api("/api/subscriptions/import", { method: "POST", body: $("#file").files[0] || $("#paste").value })).message;
  } catch (err) {
    out.textContent = err.message;
  }
  go.disabled = false;
};
