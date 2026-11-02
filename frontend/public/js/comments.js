import { $, api, channelHref, clone, safeImg } from "./lib.js";
import { timeAgo } from "./fmt.js";

// Loaded on first use (dynamic import from watch.js), so it costs nothing until comments are opened.
// All comment text is plain text from the server and goes in with textContent; links in it are never made clickable.

const plural = (n, w) => `${n.toLocaleString("en-US")} ${w}${n === 1 ? "" : "s"}`;

const MAX_SHOWN = 200; // rendered per list: the DOM stays bounded however long the thread is

// One paged list: [box] gets the items, [more] is its Load more button, [say] shows status text, [empty] is said when there are none.
function feed(path, params, box, more, say, empty) {
  const f = { token: "", busy: false, dead: false };
  more.onclick = f.load = async () => {
    if (f.busy) return;
    f.busy = more.disabled = true;
    say("Loading…");
    try {
      const q = new URLSearchParams(params);
      if (f.token) q.set("pageToken", f.token);
      const r = await api(`${path}?${q}`);
      if (f.dead) return;
      for (const c of r.items) box.append(node(c));
      f.token = r.nextPageToken || "";
      const full = box.children.length >= MAX_SHOWN;
      more.hidden = !f.token || full;
      more.textContent = more.dataset.label;
      say(full && f.token ? `Showing the first ${MAX_SHOWN}.` : box.children.length ? "" : empty);
    } catch (e) {
      if (f.dead) return;
      const off = e.code === "comments-disabled";
      say(off ? "Comments are turned off for this video." : e.message);
      more.hidden = off;
      more.textContent = box.children.length ? more.dataset.label : "Try again";
    } finally {
      f.busy = false;
      if (!f.dead) more.disabled = false;
    }
  };
  return f;
}

function node(c) {
  const n = clone("t-comment"), rp = $(".rp", n), rl = $(".rl", n), au = $(".au", n);
  const [rb, rs, rm] = [".rb", ".rs", ".rm"].map((c) => $(c, rl)); // looked up now: later, replies inside rb have their own
  const img = safeImg(c.authorThumb);
  if (img) $(".av", n).src = img;
  else $(".av", n).hidden = true;
  au.textContent = c.author;
  if (c.authorChannelId) au.href = channelHref(c.authorChannelId);
  $(".ag", n).textContent = timeAgo(c.publishedAt) + (c.updatedAt ? " (edited)" : "");
  $(".ct", n).textContent = c.text;
  $(".lk", n).textContent = c.likeCount ? plural(c.likeCount, "like") : "";
  let replies;
  rp.hidden = !c.replyCount;
  const label = (open) => `${open ? "Hide" : "Show"} ${c.replyCount.toLocaleString("en-US")} ${c.replyCount === 1 ? "reply" : "replies"}`;
  rp.textContent = label(false);
  rp.onclick = () => {
    const open = rl.hidden;
    rl.hidden = !open;
    rp.setAttribute("aria-expanded", open);
    rp.textContent = label(open);
    if (open && !replies) (replies = feed(`/api/comments/${encodeURIComponent(c.id)}/replies`, {}, rb, rm, (t) => (rs.textContent = t), "No replies.")).load();
  };
  return n;
}

let started = false, current;

function show(order) {
  if (current) current.dead = true;
  const list = $("#cm-list");
  list.replaceChildren();
  $("#cm-more").hidden = true; // the other order's Load more and message do not apply
  $("#cm-msg").textContent = "";
  for (const b of document.querySelectorAll("#cm-order button")) b.setAttribute("aria-pressed", b.dataset.o === order);
  current = feed(`/api/video/${encodeURIComponent(started)}/comments`, { order }, list, $("#cm-more"), (t) => ($("#cm-msg").textContent = t), "No comments yet.");
  current.load();
}

// Opens or closes the section; the first opening loads the first page.
export function toggleComments(id, btn) {
  const body = $("#cm-body"), open = body.hidden;
  body.hidden = !open;
  btn.setAttribute("aria-expanded", open);
  btn.textContent = btn.textContent.replace(open ? "Show" : "Hide", open ? "Hide" : "Show");
  if (!open || started) return;
  started = id;
  for (const b of document.querySelectorAll("#cm-order button")) b.onclick = () => b.getAttribute("aria-pressed") !== "true" && show(b.dataset.o);
  show("top");
}
