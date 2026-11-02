import { api } from "./lib.js";

// Subscribe / Unsubscribe button (channel page and channel search results). A failure keeps the label and is shown in errEl.
export function subToggle(button, id, on, errEl) {
  const paint = () => (button.textContent = on ? "Unsubscribe" : "Subscribe");
  paint();
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      on = (await api(`/api/${on ? "unsubscribe" : "subscribe"}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ id }) })).subscribed;
      button.title = errEl.textContent = "";
    } catch (err) {
      button.title = errEl.textContent = err.message; // keep the label; show why it failed on hover and to screen readers
    } finally {
      paint();
      button.disabled = false;
    }
  });
}
