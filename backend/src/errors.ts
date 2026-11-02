import { BusyError } from "./limit.ts";
import { QuotaError } from "./tabquota.ts";

/** The closed set of failure kinds a client can see. Codes are stable: clients switch on them. */
export const CODES = [
  "age-restricted",
  "region-blocked",
  "private",
  "removed",
  "members-only",
  "comments-disabled",
  "stale-page",
  "live",
  "upcoming",
  "bot-check",
  "rate-limited",
  "network",
  "busy",
  "no-subtitles",
  "unknown",
] as const;
export type ErrorCode = (typeof CODES)[number];

interface Info {
  status: number;
  message: string;
  retryable: boolean;
}

/** HTTP status, user-safe message and retry advice per code. Messages never contain URLs, ids, paths or upstream text. */
export const INFO: Record<ErrorCode, Info> = {
  "age-restricted": { status: 403, message: "This video is age-restricted and can't be played here.", retryable: false },
  "region-blocked": { status: 403, message: "This video isn't available in the server's region.", retryable: false },
  private: { status: 404, message: "This video is private.", retryable: false },
  removed: { status: 404, message: "This video was removed or is no longer available.", retryable: false },
  "members-only": { status: 403, message: "This video is only for channel members.", retryable: false },
  "comments-disabled": { status: 403, message: "Comments are turned off for this video.", retryable: false },
  "stale-page": { status: 400, message: "That page of results is no longer valid. Reload and try again.", retryable: true },
  live: { status: 409, message: "This is a live stream, which can't be played here.", retryable: false },
  upcoming: { status: 409, message: "This live event hasn't started yet.", retryable: false },
  "bot-check": { status: 502, message: "YouTube is asking the server to prove it isn't a bot. Try again later.", retryable: true },
  "rate-limited": { status: 429, message: "YouTube is limiting requests right now. Try again in a while.", retryable: true },
  network: { status: 502, message: "Couldn't reach YouTube. Check the server's connection and try again.", retryable: true },
  busy: { status: 503, message: "The server is busy. Try again in a few seconds.", retryable: true },
  "no-subtitles": { status: 404, message: "This video has no subtitles in that language.", retryable: false },
  unknown: { status: 502, message: "Something went wrong talking to YouTube. Check the backend log.", retryable: true },
};

export const isCode = (c: unknown): c is ErrorCode => typeof c === "string" && (CODES as readonly string[]).includes(c);

/** The body of every classified error response. `error` stays for clients that predate `code`. */
export function errorBody(code: ErrorCode, message = INFO[code].message): { error: string; code: ErrorCode; retryable: boolean } {
  return { error: message, code, retryable: INFO[code].retryable };
}

/** Codes where retrying this video is pointless, so a client that plays several (TV mode) should move on. */
export const SKIPPABLE: ReadonlySet<ErrorCode> = new Set<ErrorCode>(["age-restricted", "region-blocked", "private", "removed", "members-only", "live", "upcoming"]);

/**
 * yt-dlp stderr patterns, first match wins, so order matters: specific before general. Tested against fixtures of
 * real messages (errors.test.ts). Matched case-insensitively after folding curly quotes to straight ones.
 */
export const YTDLP_PATTERNS: ReadonlyArray<readonly [ErrorCode, RegExp]> = [
  ["age-restricted", /confirm your age|age.restricted|inappropriate for some users|age verification/],
  ["bot-check", /confirm you're not a bot|not a bot|use --cookies-from-browser or --cookies/],
  ["rate-limited", /http error 429|too many requests|rate.?limit|content isn't available, try again later/],
  ["region-blocked", /not available in your country|blocked it in your country|available in your country|geo.?restrict|who has blocked it|uploader has not made this video available/],
  ["members-only", /members.only|join this channel|available to this channel's members|channel members on level/],
  ["private", /private video|video is private|sign in if you've been granted access/],
  ["upcoming", /live event will begin|premieres in|premiere will begin|this video is scheduled|will begin in/],
  ["live", /is a live stream|currently live|live stream is not supported|is live\b/],
  ["removed", /video unavailable|has been removed|no longer available|account associated with this video has been terminated|has been terminated|video has been deleted|this video is unavailable|copyright claim|\bvideo is not available\b/],
  ["network", /unable to download|timed out|timeout|name or service not known|temporary failure in name resolution|connection (refused|reset|aborted)|network is unreachable|getaddrinfo|econnreset|econnrefused|enotfound|eai_again|remote end closed|incompleteread|\bssl\b|unexpected eof/],
];

/** Classify free text (yt-dlp stderr, an error message) or null when nothing matches. */
export function classifyText(text: string): ErrorCode | null {
  // The "[youtube] <id>:" prefix is not message text (an id can spell anything); format errors are not about the video.
  const t = text.toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").replace(/\[[\w:.-]+\]\s+[\w-]{11}:\s*/g, "");
  if (/requested format is not available/.test(t)) return null;
  for (const [code, re] of YTDLP_PATTERNS) if (re.test(t)) return code;
  return null;
}

/** Thrown when a video has no usable subtitle track in the requested language (also an oversized or non-WebVTT download: retrying won't help). */
export class NoSubtitles extends Error {
  constructor(why = "no subtitles") {
    super(why);
  }
}

/** A failed Data API call: the HTTP status and first error `reason` only, never the URL (it contains the key). */
export class UpstreamError extends Error {
  status: number;
  reason: string;
  constructor(message: string, status: number, reason = "") {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

const QUOTA_REASONS = /^(quotaexceeded|ratelimitexceeded|userratelimitexceeded|dailylimitexceeded|dailylimitexceededunreg|concurrentlimitexceeded)$/i;

/** Data API failure to code: quota reasons and 429 are rate limits, "not found" reasons are removals, the rest unknown. */
export function classifyUpstream(status: number, reason: string): ErrorCode {
  if (/^commentsdisabled$/i.test(reason)) return "comments-disabled";
  if (/^invalidpagetoken$/i.test(reason)) return "stale-page";
  if (/^forbidden$/i.test(reason)) return "private"; // the video (or its comments) is not open to this key: shown like a private video
  if (/^processingfailure$/i.test(reason)) return "network"; // YouTube's own transient failure: retryable
  if (status === 429 || QUOTA_REASONS.test(reason)) return "rate-limited";
  if (status === 404 || /notfound$/i.test(reason)) return "removed";
  if (status === 408 || status === 504) return "network";
  return "unknown";
}

/** The text worth classifying in an error: stderr, else the message minus execFile's "Command failed: <cmdline>" line (it holds the URL). */
export function errorText(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | null;
  const stderr = typeof e?.stderr === "string" ? e.stderr : "";
  const message = typeof e?.message === "string" ? e.message.replace(/^Command failed:.*(\n|$)/, "") : "";
  return `${stderr}\n${message}`;
}

/** The one classification source: any thrown value to a code. */
export function classifyError(err: unknown): ErrorCode {
  if (err instanceof BusyError) return "busy";
  if (err instanceof NoSubtitles) return "no-subtitles";
  if (err instanceof QuotaError) return "rate-limited"; // our own daily budgets for channel tabs and comments
  if (err instanceof UpstreamError) return classifyUpstream(err.status, err.reason);
  const e = err as { code?: unknown; killed?: boolean; name?: string; message?: string; stderr?: string; cause?: { code?: unknown } } | null;
  if (e?.code === "ENOENT") return "unknown"; // the tool is missing: an operator problem, not a network one
  const fromText = classifyText(errorText(err));
  if (fromText) return fromText;
  if (e?.killed || e?.name === "TimeoutError" || e?.name === "AbortError") return "network";
  // fetch() rejects with TypeError("fetch failed") and a cause carrying the errno.
  if (e instanceof TypeError && /fetch failed/i.test(e.message ?? "")) return "network";
  if (typeof e?.cause?.code === "string" && /^(ECONN|ENOTFOUND|EAI_|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR)/.test(e.cause.code)) return "network";
  return "unknown";
}
