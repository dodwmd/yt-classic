import { test } from "node:test";
import assert from "node:assert/strict";
import { CODES, INFO, SKIPPABLE, UpstreamError, classifyError, classifyText, classifyUpstream, errorBody, errorText, type ErrorCode } from "./errors.ts";
import { BusyError } from "./limit.ts";

// Messages as yt-dlp prints them (curly apostrophes included where YouTube's text has them).
const FIXTURES: Array<[ErrorCode, string]> = [
  ["age-restricted", "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. This video may be inappropriate for some users."],
  ["age-restricted", "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm your age. Use --cookies-from-browser or --cookies for the authentication."],
  ["age-restricted", "ERROR: [youtube] abcdefghijk: This video is age-restricted and only available on YouTube. Sign in to confirm your age"],
  ["bot-check", "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies for the authentication. See  https://github.com/yt-dlp/yt-dlp/wiki/FAQ  for how to manually pass cookies."],
  ["bot-check", "ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you're not a bot"],
  ["rate-limited", "ERROR: [youtube] dQw4w9WgXcQ: Unable to download API page: HTTP Error 429: Too Many Requests"],
  ["rate-limited", "ERROR: [youtube] dQw4w9WgXcQ: The current session has been rate-limited by YouTube for up to an hour. It is recommended to use `-t sleep` to add a delay between video requests to avoid exceeding the rate limit."],
  ["rate-limited", "ERROR: [youtube] dQw4w9WgXcQ: This content isn’t available, try again later."],
  ["region-blocked", "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video is not available in your country"],
  ["region-blocked", "ERROR: [youtube] dQw4w9WgXcQ: The uploader has not made this video available in your country"],
  ["region-blocked", "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video contains content from SME, who has blocked it in your country on copyright grounds"],
  ["private", "ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you’ve been granted access to this video"],
  ["private", "ERROR: [youtube] dQw4w9WgXcQ: Private video. Sign in if you've been granted access to this video"],
  ["members-only", "ERROR: [youtube] dQw4w9WgXcQ: Join this channel to get access to members-only content like this video, and other exclusive perks."],
  ["members-only", "ERROR: [youtube] dQw4w9WgXcQ: This video is available to this channel’s members on level: Gold (or any higher level). Join this channel to get access to members-only content"],
  ["upcoming", "ERROR: [youtube] dQw4w9WgXcQ: This live event will begin in 3 hours."],
  ["upcoming", "ERROR: [youtube] dQw4w9WgXcQ: Premieres in 2 days"],
  ["upcoming", "ERROR: [youtube] dQw4w9WgXcQ: This live event will begin in a few moments."],
  ["live", "ERROR: [youtube] dQw4w9WgXcQ: This video is currently live"],
  ["removed", "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable"],
  ["removed", "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed by the uploader"],
  ["removed", "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video has been removed for violating YouTube’s Terms of Service"],
  ["removed", "ERROR: [youtube] dQw4w9WgXcQ: Video unavailable. This video is no longer available because the YouTube account associated with this video has been terminated."],
  ["removed", "ERROR: [youtube] dQw4w9WgXcQ: This video is unavailable"],
  ["network", "ERROR: [youtube] dQw4w9WgXcQ: Unable to download webpage: <urlopen error [Errno -3] Temporary failure in name resolution> (caused by URLError(gaierror(-3, 'Temporary failure in name resolution')))"],
  ["network", "ERROR: [youtube] dQw4w9WgXcQ: Unable to download webpage: The read operation timed out"],
  ["network", "ERROR: [youtube] dQw4w9WgXcQ: Unable to download webpage: <urlopen error [Errno 101] Network is unreachable>"],
  ["network", "ERROR: [youtube] dQw4w9WgXcQ: Unable to download webpage: ('Connection aborted.', ConnectionResetError(104, 'Connection reset by peer'))"],
];

// comments-disabled comes only from the Data API (classifyUpstream), never from yt-dlp text.
test("every real yt-dlp message maps to its code", () => {
  for (const [code, text] of FIXTURES) assert.equal(classifyText(text), code, text);
  for (const code of CODES) if (code !== "busy" && code !== "unknown" && code !== "comments-disabled" && code !== "stale-page" && code !== "no-subtitles" && code !== "no-storyboard") assert.ok(FIXTURES.some(([c]) => c === code), `a fixture for ${code}`);
});

test("ambiguous messages resolve to the more specific code", () => {
  // "Sign in to confirm ..." is age before bot; "Video unavailable. ... in your country" is region, not removed.
  assert.equal(classifyText("Sign in to confirm your age. Use --cookies-from-browser or --cookies for the authentication."), "age-restricted");
  assert.equal(classifyText("Video unavailable. This video is not available in your country"), "region-blocked");
  assert.equal(classifyText("Video unavailable. Private video"), "private");
  assert.equal(classifyText("Unable to download API page: HTTP Error 429: Too Many Requests"), "rate-limited"); // not network
  assert.equal(classifyText("Video unavailable. This video is available to this channel's members"), "members-only");
});

test("text that means nothing stays unclassified", () => {
  for (const t of ["", "ERROR: something odd", "HTTP Error 403: Forbidden", "ffmpeg exploded"]) assert.equal(classifyText(t), null, t);
  // A quality miss says nothing about the video: not removed, not skippable (and so never remembered as unplayable).
  for (const t of [
    "ERROR: [youtube] dQw4w9WgXcQ: Requested format is not available. Use --list-formats for a list of available formats",
    "ERROR: unable to download video data: HTTP Error 403: Forbidden",
    "ERROR: [youtube] dQw4w9WgXcQ: This video is only available to Music Premium members",
  ]) {
    const c = classifyText(t);
    assert.ok(c === null || !SKIPPABLE.has(c), `${t} -> ${c}`);
  }
  assert.equal(classifyText("ERROR: [youtube] dQw4w9WgXcQ: Requested format is not available. Use --list-formats"), null);
  assert.equal(classifyError(new Error("kaboom")), "unknown");
  assert.equal(classifyError(null), "unknown");
});

test("the [youtube] <id>: prefix is not message text", () => {
  // An id may spell anything; only the text after the prefix counts.
  assert.equal(classifyText("ERROR: [youtube] x-timeout-x: Something odd happened"), null);
  assert.equal(classifyText("ERROR: [youtube] sslsslsslss: Something odd happened"), null);
  assert.equal(classifyText("ERROR: [youtube:tab] UCaaaaaaaaa: The channel is not available"), null);
  assert.equal(classifyText("ERROR: [youtube] dQw4w9WgXcQ: Video unavailable"), "removed");
});

test("classifyError: busy, timeouts, missing tool, fetch failures", () => {
  assert.equal(classifyError(new BusyError()), "busy");
  assert.equal(classifyError(Object.assign(new Error("Command failed"), { killed: true })), "network");
  assert.equal(classifyError(Object.assign(new Error("x"), { code: "ENOENT" })), "unknown");
  assert.equal(classifyError(new DOMException("timed out", "TimeoutError")), "network");
  assert.equal(classifyError(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), "network");
  assert.equal(classifyError(Object.assign(new Error("Command failed: yt-dlp"), { stderr: "ERROR: Private video" })), "private");
});

test("the command line in an execFile message is never classified (its URL and format string are noise)", () => {
  const e = Object.assign(new Error("Command failed: yt-dlp -f b -g -- https://www.youtube.com/watch?v=timeoutXXXX\nERROR: Video unavailable"), {});
  assert.equal(classifyError(e), "removed");
  assert.ok(!errorText(e).includes("watch?v="));
});

test("Data API failures: quota reasons, 429, not-found, the rest", () => {
  for (const reason of ["quotaExceeded", "rateLimitExceeded", "userRateLimitExceeded", "dailyLimitExceeded"]) assert.equal(classifyUpstream(403, reason), "rate-limited", reason);
  assert.equal(classifyUpstream(429, ""), "rate-limited");
  assert.equal(classifyUpstream(404, "videoNotFound"), "removed");
  assert.equal(classifyUpstream(403, "commentsDisabled"), "comments-disabled");
  assert.equal(classifyUpstream(403, "commentsdisabled"), "comments-disabled");
  assert.equal(classifyUpstream(403, "commentNotFound"), "removed");
  assert.equal(classifyError(new UpstreamError("YouTube API commentThreads failed: 403 disabled comments", 403, "commentsDisabled")), "comments-disabled");
  assert.equal(classifyUpstream(403, "forbidden"), "private");
  assert.equal(classifyUpstream(400, "invalidPageToken"), "stale-page");
  assert.equal(classifyUpstream(400, "processingFailure"), "network");
  assert.equal(classifyUpstream(404, "videoNotFound"), "removed");
  assert.equal(INFO["stale-page"].retryable, true);
  assert.equal(classifyUpstream(403, "somethingElse"), "unknown");
  assert.equal(classifyUpstream(500, ""), "unknown");
  assert.equal(classifyUpstream(504, ""), "network");
  assert.equal(classifyError(new UpstreamError("YouTube API videos failed: 403 The request cannot be completed because you have exceeded your quota.", 403, "quotaExceeded")), "rate-limited");
});

test("the table: every code has a status, a safe message and a boolean retryable", () => {
  const statuses: Record<ErrorCode, number> = {
    "age-restricted": 403, "region-blocked": 403, "members-only": 403, "comments-disabled": 403, "stale-page": 400, private: 404, removed: 404,
    "rate-limited": 429, busy: 503, "bot-check": 502, network: 502, unknown: 502, live: 409, upcoming: 409, "no-subtitles": 404, "no-storyboard": 404,
  };
  assert.deepEqual(Object.keys(INFO).sort(), [...CODES].sort());
  for (const code of CODES) {
    const i = INFO[code];
    assert.equal(i.status, statuses[code], code);
    assert.equal(typeof i.retryable, "boolean");
    assert.doesNotMatch(i.message, /https?:|\/|\\|token|key|stderr|yt-dlp|ffmpeg|[A-Za-z0-9_-]{11}\.\w/i, `${code} message leaks: ${i.message}`);
    assert.deepEqual(errorBody(code), { error: i.message, code, retryable: i.retryable });
  }
  assert.deepEqual([...SKIPPABLE].sort(), ["age-restricted", "live", "members-only", "private", "region-blocked", "removed", "upcoming"]);
  for (const c of SKIPPABLE) assert.equal(INFO[c].retryable, false, `${c} is skippable so retrying is pointless`);
});

test("no message echoes upstream text: the body is built from the table, whatever the error said", () => {
  const e = Object.assign(new Error("boom https://www.youtube.com/watch?v=SECRETVID01 /home/u/.cache token=abc"), { stderr: "ERROR: Private video https://x.invalid/?key=SECRET" });
  const body = JSON.stringify(errorBody(classifyError(e)));
  for (const leak of ["SECRETVID01", "youtube.com", "/home", "token=", "SECRET"]) assert.ok(!body.includes(leak), leak);
});
