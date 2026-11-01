import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { DatabaseSync } from "node:sqlite";
import { getDb, stmt } from "./db.ts";

/**
 * Optional shared access token (env ACCESS_TOKEN). Unset = open, as before.
 *
 * Browsers cannot send an Authorization header from <video src> or a plain page load, so /api/login trades the token
 * for an HttpOnly cookie. The cookie never contains the token: it is `<expiry>.<HMAC-SHA256(token, "session:<expiry>")>`.
 * That is stateless (no table, survives restarts, expiry enforced here and not only by the browser) and changing
 * ACCESS_TOKEN invalidates every session. The cost is that a single session cannot be revoked before it expires
 * (rotate the token for that).
 */
export const COOKIE = "yt_session";
export const SESSION_SECONDS = 30 * 24 * 3600;

export function accessToken(): string {
  return process.env.ACCESS_TOKEN ?? "";
}

const digest = (s: string) => createHash("sha256").update(s).digest();

/** Constant-time string equality: both sides are hashed to 32 bytes first, so length differences leak nothing. */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

const sign = (key: string, exp: number) => createHmac("sha256", key).update(`session:${exp}`).digest("hex");

const secrets = new WeakMap<DatabaseSync, string>();
/**
 * The HMAC key for session cookies: HMAC(random secret persisted in the database `meta` table, ACCESS_TOKEN). The
 * random part means a sniffed cookie cannot be brute-forced offline against a weak token; the token part means
 * rotating ACCESS_TOKEN still signs everyone out; the persistence means sessions survive restarts.
 */
export function sessionKey(token: string): string {
  const db = getDb();
  let secret = secrets.get(db);
  if (!secret) {
    stmt(db, "INSERT OR IGNORE INTO meta (key, value) VALUES ('session_secret', ?)").run(randomBytes(32).toString("hex"));
    secret = (stmt(db, "SELECT value FROM meta WHERE key = 'session_secret'").get() as { value: string }).value;
    secrets.set(db, secret);
  }
  return createHmac("sha256", secret).update(token).digest("hex");
}

export function makeSession(key: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SESSION_SECONDS;
  return `${exp}.${sign(key, exp)}`;
}

export function validSession(key: string, value: string, now = Date.now()): boolean {
  const m = /^([1-9]\d{0,11})\.([0-9a-f]{64})$/.exec(value);
  if (!m) return false;
  const exp = Number(m[1]);
  if (exp * 1000 <= now) return false;
  return safeEqual(m[2], sign(key, exp));
}

export const MIN_TOKEN = 16;
export const MAX_TOKEN = 512;

/** Why [token] can't be used, or null. Every accepted token can be sent verbatim as `Bearer <token>`. */
export function tokenProblem(token: string): string | null {
  if (token.length < MIN_TOKEN) return `ACCESS_TOKEN is too short (${token.length} characters; use at least ${MIN_TOKEN}, for example \`openssl rand -hex 24\`)`;
  if (token.length > MAX_TOKEN) return `ACCESS_TOKEN is too long (more than ${MAX_TOKEN} characters)`;
  if (!/^[\x21-\x7e]+$/.test(token) || token.includes(",")) return "ACCESS_TOKEN may only contain printable ASCII characters without spaces or commas";
  return null;
}

/** Start-up decision from the environment: throws with a clear message when the configuration must not run. */
export function checkAuthConfig(env: NodeJS.ProcessEnv): "open" | "token" {
  const token = env.ACCESS_TOKEN;
  if (token === undefined || token === "") {
    if (env.REQUIRE_AUTH === "1") throw new Error("REQUIRE_AUTH=1 but ACCESS_TOKEN is empty or unset: refusing to start without authentication");
    return "open";
  }
  const problem = tokenProblem(token);
  if (problem) throw new Error(problem);
  return "token";
}

/** Every value of the named cookie (a stale duplicate must not hide a valid one). */
export function cookieValues(header: string | undefined, name: string): string[] {
  const out: string[] = [];
  for (const part of (header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  return out;
}

/** The token from `Authorization: Bearer <token>`, or null when absent or malformed. */
export function bearer(header: string | undefined): string | null {
  const m = /^Bearer[ \t]+([^\s,]{1,512})[ \t]*$/i.exec(header ?? "");
  return m ? m[1] : null;
}

export type Verdict = "ok" | "none" | "bad";

/** ok = valid bearer or session cookie; bad = a bearer was presented and is wrong; none = no usable credentials. */
export function check(req: IncomingMessage, token: string, key: () => string = () => sessionKey(token)): Verdict {
  const b = bearer(req.headers.authorization);
  if (b !== null) return safeEqual(b, token) ? "ok" : "bad";
  const values = cookieValues(req.headers.cookie, COOKIE).slice(0, 5); // a header stuffed with duplicates stays cheap
  if (values.length && values.some((v) => validSession(key(), v))) return "ok";
  return "none";
}

export function cookieHeader(value: string, maxAge: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** Behind the bundled nginx the peer is nginx; it sets X-Forwarded-For to the real client. */
export function clientIp(req: IncomingMessage): string {
  const xff = req.headers["x-forwarded-for"];
  const last = (Array.isArray(xff) ? xff.join(",") : xff ?? "").split(",").pop()?.trim();
  return last || req.socket.remoteAddress || "unknown";
}

/** In-memory failure limiter: `max` failures per `windowMs` per key, then blocked until the oldest one expires. */
export function failureLimiter(max: number, windowMs: number, maxKeys = 2000) {
  const hits = new Map<string, number[]>();
  const live = (key: string, now: number) => {
    const a = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (a.length) hits.set(key, a);
    else hits.delete(key);
    return a;
  };
  return {
    /** Seconds to wait, or 0 when allowed. */
    blockedFor(key: string, now = Date.now()): number {
      const a = live(key, now);
      return a.length >= max ? Math.max(1, Math.ceil((a[0] + windowMs - now) / 1000)) : 0;
    },
    fail(key: string, now = Date.now()): void {
      if (!hits.has(key) && hits.size >= maxKeys) {
        for (const k of hits.keys()) if (!live(k, now).length) hits.delete(k);
        if (hits.size >= maxKeys) hits.delete(hits.keys().next().value as string);
      }
      const a = live(key, now);
      a.push(now);
      hits.set(key, a);
    },
    size: () => hits.size,
  };
}

/**
 * Failed-attempt bookkeeping and the credential check, built per app so state is never shared between servers.
 * 10 failures per client per 5 minutes (plus a looser global cap of 200, which bounds guessing even when
 * X-Forwarded-For is spoofed). While a client is locked, a request that presents a bearer or login token is refused
 * even if the token is right: otherwise 429 versus 200 would let it keep guessing. Valid session cookies are
 * unguessable and bypass the lock. Memory is bounded (2000 tracked clients).
 */
export const LOCK_WINDOW_MS = 5 * 60_000;
export function createGate() {
  const perClient = failureLimiter(10, LOCK_WINDOW_MS);
  const global = failureLimiter(200, LOCK_WINDOW_MS);
  const GLOBAL = "*";
  const lockedFor = (ip: string) => Math.max(perClient.blockedFor(ip), global.blockedFor(GLOBAL));
  const noteFailure = (ip: string) => (perClient.fail(ip), global.fail(GLOBAL));
  /** ok / none (no credentials) / bad (wrong bearer, counted) / seconds to wait. */
  function authenticate(req: IncomingMessage, token: string, ip: string): Verdict | number {
    const v = check(req, token);
    if (bearer(req.headers.authorization) === null) return v;
    const wait = lockedFor(ip);
    if (wait) return wait;
    if (v === "bad") noteFailure(ip);
    return v;
  }
  return { lockedFor, noteFailure, authenticate, perClient, global };
}

/**
 * Where a browser goes after a form login: a same-origin path (+ query + hash) or "/". Refuses control characters
 * (browsers strip tabs and newlines, so "/<TAB>/evil.com" would become "//evil.com"), backslashes, "//", and
 * percent-encoded forms of them.
 */
export function safeNext(next: string | null | undefined): string {
  if (typeof next !== "string" || next.length > 2000 || !/^\/(?!\/)/.test(next)) return "/";
  if (/%(0|1|5c|7f)/i.test(next)) return "/";
  for (let i = 0; i < next.length; i++) {
    const c = next.charCodeAt(i);
    if (c <= 32 || c === 127 || c === 92) return "/"; // control characters, space, backslash
  }
  try {
    const u = new URL(next, "http://same.origin");
    return u.origin === "http://same.origin" ? u.pathname + u.search + u.hash : "/";
  } catch {
    return "/";
  }
}
