/** fetch with a default timeout so one stalled upstream can't hang a page. */
export function fetchT(url: string | URL, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
}

/** User-controlled text made safe for one log line: control characters (CR, LF, ESC...) become spaces and the length is capped. */
export function logSafe(text: unknown, max = 200): string {
  const s = String(text).replace(/\n|\r/g, " ").replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, " ");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}
