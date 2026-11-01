/** fetch with a default timeout so one stalled upstream can't hang a page. */
export function fetchT(url: string | URL, init: RequestInit = {}, ms = 10_000): Promise<Response> {
  return fetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
}
