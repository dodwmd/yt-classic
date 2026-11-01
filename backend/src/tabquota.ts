import { envInt } from "./env.ts";

/**
 * Data API budget for the channel tab routes. Page tokens and ids are client-supplied, so without a cap a client could mint
 * endless distinct cache keys and burn the daily quota. Units are counted when a request is made (whether or not it succeeds).
 */
export class QuotaError extends Error {
  retryAfter: number;
  constructor(message: string, retryAfter: number) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

let day = "";
let used = 0;
let hour = 0;
let requests = 0;

/** Counts [units] against today's budget (TAB_UNITS_MAX, default 500); throws QuotaError once it is used up. */
export function spend(units: number): void {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (today !== day) [day, used] = [today, 0];
  if (used + units > envInt("TAB_UNITS_MAX", 500)) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    throw new QuotaError("The daily YouTube quota set aside for channel tabs is used up. Try again tomorrow.", Math.max(1, Math.ceil((midnight - now.getTime()) / 1000)));
  }
  used += units;
}

/** Global cap on tab requests per hour (TAB_REQUESTS_PER_HOUR, default 1200), cached or not. Returns 0 when allowed, else seconds to wait. */
export function tabRequestWait(): number {
  const now = Date.now();
  const h = Math.floor(now / 3_600_000);
  if (h !== hour) [hour, requests] = [h, 0];
  if (requests >= envInt("TAB_REQUESTS_PER_HOUR", 1200)) return Math.max(1, Math.ceil(((h + 1) * 3_600_000 - now) / 1000));
  requests++;
  return 0;
}

export function resetTabQuota(): void {
  [day, used, hour, requests] = ["", 0, 0, 0];
}
