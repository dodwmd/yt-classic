import { envInt } from "./env.ts";
import { QuotaError } from "./tabquota.ts";

/**
 * Data API budget for the comment routes, in the style of tabquota.ts but separate from it: page tokens and ids are
 * client-supplied, so without a cap a client could mint endless distinct cache keys and burn the daily quota. Units are
 * counted when an upstream request is made (whether or not it succeeds); the hourly cap counts every request, cached or not.
 */
let day = "";
let used = 0;
let hour = 0;
let requests = 0;

/** Counts [units] against today's budget (COMMENT_UNITS_MAX, default 300); throws QuotaError once it is used up. */
export function spendComments(units: number): void {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (today !== day) [day, used] = [today, 0];
  if (used + units > envInt("COMMENT_UNITS_MAX", 300)) {
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    throw new QuotaError("The daily YouTube quota set aside for comments is used up. Try again tomorrow.", Math.max(1, Math.ceil((midnight - now.getTime()) / 1000)));
  }
  used += units;
}

/** Global cap on comment requests per hour (COMMENT_REQUESTS_PER_HOUR, default 600). Returns 0 when allowed, else seconds to wait. */
export function commentRequestWait(): number {
  const now = Date.now();
  const h = Math.floor(now / 3_600_000);
  if (h !== hour) [hour, requests] = [h, 0];
  if (requests >= envInt("COMMENT_REQUESTS_PER_HOUR", 600)) return Math.max(1, Math.ceil(((h + 1) * 3_600_000 - now) / 1000));
  requests++;
  return 0;
}

export function resetCommentQuota(): void {
  [day, used, hour, requests] = ["", 0, 0, 0];
}
