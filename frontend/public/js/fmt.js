// Display formatting. Pure functions (no DOM) so they can be unit-tested.

export function formatSeconds(total) {
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = Math.floor(total % 60);
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** "2 days ago"; empty for missing or invalid dates. */
export function timeAgo(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, (now - t) / 1000);
  const units = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, size] of units) {
    let n = Math.floor(secs / size);
    if (name === "month") n = Math.min(n, 11); // 360-364 days is still "11 months", not "12"
    if (n >= 1) return `${n} ${name}${n > 1 ? "s" : ""} ago`;
  }
  return "just now";
}

/** "1,234 views"; empty when unknown. */
export function formatViews(n) {
  return n === undefined || n === null || n === "" ? "" : `${Number(n).toLocaleString("en-US")} views`;
}

/** Display strings from the watch-next feed ("1.2M", "3K watching"): add "views" only when it isn't there. */
export function viewsText(v) {
  return /view|watching/i.test(v) ? v : `${v} views`;
}

export const join = (...parts) => parts.filter(Boolean).join(" · ");
