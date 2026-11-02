import { CODES, isCode, type ErrorCode } from "./errors.ts";

/**
 * In-memory counters for /api/metrics (reset on restart). Cardinality is bounded by construction: every label value
 * comes from a closed list in this file (route classes, status classes, error codes); anything else is folded into
 * a fixed bucket, so no request path, id or query can ever add a series.
 */

export const ROUTE_CLASSES = ["healthz", "status", "metrics", "auth", "home", "search", "video", "comments", "channel", "history", "subscriptions", "stream", "page", "other"] as const;
export type RouteClass = (typeof ROUTE_CLASSES)[number];
export const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx"] as const;

const ROUTES: ReadonlyArray<readonly [string, RouteClass]> = [
  ["/healthz", "healthz"], ["/api/status", "status"], ["/status", "status"], ["/api/metrics", "metrics"],
  ["/api/session", "auth"], ["/api/login", "auth"], ["/api/logout", "auth"], ["/api/home", "home"], ["/api/search", "search"],
  ["/api/video/", "video"], ["/api/comments/", "comments"], ["/api/channel/", "channel"], ["/api/history", "history"], ["/api/progress", "history"],
  ["/api/subscriptions", "subscriptions"], ["/api/subscribe", "subscriptions"], ["/api/unsubscribe", "subscriptions"], ["/stream/", "stream"],
];
const PAGES = new Set(["/", "/results", "/watch", "/history", "/subscriptions", "/login"]);

/** Fixed route class of a request path. */
export function routeClass(path: string): RouteClass {
  for (const [prefix, cls] of ROUTES) if (path === prefix || (prefix.endsWith("/") ? path.startsWith(prefix) : path.startsWith(prefix + "/"))) return cls;
  return PAGES.has(path) || path.startsWith("/channel/") || path.startsWith("/static/") ? "page" : "other";
}

export const statusClass = (status: number): (typeof STATUS_CLASSES)[number] => STATUS_CLASSES[Math.min(4, Math.max(0, Math.floor(status / 100) - 1))];

const requests = new Map<string, number>();
const errors = new Map<ErrorCode, number>();
let streamsActive = 0;
let streamsStarted = 0;
let streamsFinished = 0;
let streamsFailed = 0;

export const RESOLVE_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60] as const;
const resolveCounts: number[] = RESOLVE_BUCKETS.map(() => 0);
let resolveCount = 0;
let resolveSum = 0;

export function countRequest(path: string, status: number): void {
  const key = `${routeClass(path)}|${statusClass(status)}`;
  requests.set(key, (requests.get(key) ?? 0) + 1);
}

export function countError(code: ErrorCode): void {
  const c = isCode(code) ? code : "unknown";
  errors.set(c, (errors.get(c) ?? 0) + 1);
}

export function observeResolve(seconds: number): void {
  resolveCount++;
  resolveSum += seconds;
  RESOLVE_BUCKETS.forEach((le, i) => {
    if (seconds <= le) resolveCounts[i]++;
  });
}

export const streamEvents = {
  started: () => void (streamsStarted++, streamsActive++),
  finished: () => void (streamsFinished++, streamsActive = Math.max(0, streamsActive - 1)),
  failed: () => void streamsFailed++,
};

export const streamStats = () => ({ active: streamsActive, started: streamsStarted, finished: streamsFinished, failed: streamsFailed });
export const errorCounts = (): Record<ErrorCode, number> => Object.fromEntries(CODES.map((c) => [c, errors.get(c) ?? 0])) as Record<ErrorCode, number>;

export function resetMetricsForTests(): void {
  requests.clear();
  errors.clear();
  streamsActive = streamsStarted = streamsFinished = streamsFailed = 0;
  resolveCounts.fill(0);
  resolveCount = resolveSum = 0;
}

/** Point-in-time values owned by other modules, gathered by the caller. */
export interface Gauges {
  uptimeSeconds: number;
  cacheHits: number;
  cacheMisses: number;
  cacheEntries: number;
  dbBytes: number | null;
  dataApiUnitsToday: number;
  searchFallbackRemaining: number;
}

/** Prometheus text exposition format (version 0.0.4). */
export function renderMetrics(g: Gauges): string {
  const out: string[] = [];
  const metric = (name: string, type: "counter" | "gauge" | "histogram", help: string, lines: string[]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...lines);
  };
  metric("ytclassic_streams_active", "gauge", "Streams currently being sent.", [`ytclassic_streams_active ${streamsActive}`]);
  metric("ytclassic_streams_started_total", "counter", "Streams that began sending data.", [`ytclassic_streams_started_total ${streamsStarted}`]);
  metric("ytclassic_streams_finished_total", "counter", "Streams that ended after starting (end of video or viewer left).", [`ytclassic_streams_finished_total ${streamsFinished}`]);
  metric("ytclassic_streams_failed_total", "counter", "Streams that failed before any data was sent.", [`ytclassic_streams_failed_total ${streamsFailed}`]);
  const h = RESOLVE_BUCKETS.map((le, i) => `ytclassic_resolve_seconds_bucket{le="${le}"} ${resolveCounts[i]}`);
  h.push(`ytclassic_resolve_seconds_bucket{le="+Inf"} ${resolveCount}`, `ytclassic_resolve_seconds_sum ${Number(resolveSum.toFixed(3))}`, `ytclassic_resolve_seconds_count ${resolveCount}`);
  metric("ytclassic_resolve_seconds", "histogram", "Duration of yt-dlp stream URL resolves, failed ones included (cache hits excluded).", h);
  const reqs = [...requests].sort(([a], [b]) => a.localeCompare(b)).map(([k, n]) => {
    const [route, status] = k.split("|");
    return `ytclassic_http_requests_total{route="${route}",status="${status}"} ${n}`;
  });
  metric("ytclassic_http_requests_total", "counter", "HTTP requests by route class and status class.", reqs);
  metric("ytclassic_errors_total", "counter", "Classified errors returned to clients, by error code.", CODES.map((c) => `ytclassic_errors_total{code="${c}"} ${errors.get(c) ?? 0}`));
  metric("ytclassic_cache_hits_total", "counter", "Cache lookups served from the cache.", [`ytclassic_cache_hits_total ${g.cacheHits}`]);
  metric("ytclassic_cache_misses_total", "counter", "Cache lookups that had to fetch.", [`ytclassic_cache_misses_total ${g.cacheMisses}`]);
  metric("ytclassic_cache_entries", "gauge", "Entries in the in-memory cache.", [`ytclassic_cache_entries ${g.cacheEntries}`]);
  metric("ytclassic_dataapi_units_today", "gauge", "YouTube Data API quota units spent today (UTC day, estimated, resets on restart).", [`ytclassic_dataapi_units_today ${g.dataApiUnitsToday}`]);
  metric("ytclassic_search_fallback_remaining", "gauge", "Data API search fallbacks (100 units each) left today (SEARCH_FALLBACK_MAX cap).", [`ytclassic_search_fallback_remaining ${g.searchFallbackRemaining}`]);
  metric("ytclassic_sqlite_bytes", "gauge", "Size of the SQLite database in bytes (no sample while the database is unreachable).", g.dbBytes === null ? [] : [`ytclassic_sqlite_bytes ${g.dbBytes}`]);
  metric("ytclassic_uptime_seconds", "gauge", "Seconds since the process started.", [`ytclassic_uptime_seconds ${g.uptimeSeconds}`]);
  return out.join("\n") + "\n";
}
