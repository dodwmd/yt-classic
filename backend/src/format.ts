export function formatSeconds(total: number): string {
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = Math.floor(total % 60);
  const ss = String(s).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const ISO_DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

export function isoSeconds(iso: string | undefined): number {
  const m = iso ? ISO_DURATION.exec(iso) : null;
  if (!m) return 0;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

/** "3:33" style label; empty for unknown or zero-length (live/upcoming) durations. */
export function parseDuration(iso: string): string {
  const total = isoSeconds(iso);
  return total > 0 ? formatSeconds(total) : "";
}

export function formatViews(n: string | number | undefined): string {
  if (n === undefined || n === "") return "";
  return `${Number(n).toLocaleString("en-US")} views`;
}

/** Display string from the watch-next feed ("1.2M", "3K watching"): add "views" only when it isn't there. */
export function viewsText(v: string): string {
  return /view|watching/i.test(v) ? v : `${v} views`;
}

export function timeAgo(iso: string, now = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const secs = Math.max(0, (now - t) / 1000);
  const units: [string, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [name, size] of units) {
    let n = Math.floor(secs / size);
    if (name === "month") n = Math.min(n, 11); // 360-364 days is still "11 months", not "12"
    if (n >= 1) return `${n} ${name}${n > 1 ? "s" : ""} ago`;
  }
  return "just now";
}
