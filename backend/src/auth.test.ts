import { test, before, after, afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { bearer, checkAuthConfig, cookieValues, failureLimiter, makeSession, safeEqual, safeNext, sessionKey, tokenProblem, validSession } from "./auth.ts";
import { getDb } from "./db.ts";
import { killChildren } from "./yt/dlp.ts";

const TOKEN = "correct-horse-battery-staple-TEST";
const VID = "AAAAAAAAAAA";

let server: Server;
let port = 0;
let tmp = "";
let logged = "";
const realLog = console.log;
const realErr = console.error;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "yt-auth-"));
  process.env.DATA_DIR = join(tmp, "data");
  process.env.YT_API_KEY = "test-key";
  process.env.PIDFILE = join(tmp, "ffmpeg.pid");
  const sh = (name: string, body: string) => {
    const p = join(tmp, name);
    writeFileSync(p, `#!/bin/sh\n${body}\n`);
    chmodSync(p, 0o755);
    return p;
  };
  process.env.YTDLP_BIN = sh("yt-dlp", `echo "yt-dlp ran" > "${join(tmp, "ytdlp.ran")}"; echo https://example.invalid/v; echo https://example.invalid/a`);
  process.env.FFMPEG_BIN = sh("ffmpeg", `echo $$ > "$PIDFILE"; printf xxxx; exec sleep 30`);
  console.log = (...a: unknown[]) => void (logged += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (logged += a.join(" ") + "\n");
});

after(() => {
  console.log = realLog;
  console.error = realErr;
  killChildren();
  server.closeAllConnections();
  server.close();
  rmSync(tmp, { recursive: true, force: true });
});

async function boot(): Promise<void> {
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  server = createApp(); // limiter state lives in the app, so a fresh app is a fresh limiter
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
}

afterEach(() => {
  server.closeAllConnections();
});

beforeEach(async () => {
  process.env.ACCESS_TOKEN = TOKEN;
  await boot();
  rmSync(join(tmp, "ytdlp.ran"), { force: true });
  rmSync(process.env.PIDFILE!, { force: true });
});

type Res = { status: number; body: string; headers: IncomingHttpHeaders };
function call(path: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new Promise<Res>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: opts.headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(opts.body);
  });
}
const bearerHdr = (t: string) => ({ authorization: `Bearer ${t}` });
const login = (token: string, extra: Record<string, string> = {}) =>
  call("/api/login", { method: "POST", headers: { "content-type": "application/json", ...extra }, body: JSON.stringify({ token }) });
const cookieOf = (r: Res) => String(r.headers["set-cookie"]?.[0] ?? "").split(";")[0];

test("open mode (no ACCESS_TOKEN) is unchanged", async () => {
  delete process.env.ACCESS_TOKEN;
  assert.equal((await call("/api/home")).status, 200);
  assert.deepEqual(JSON.parse((await call("/api/session")).body), { auth: "none", authenticated: true });
  assert.equal((await call("/api/nope")).status, 404);
  const l = await login("whatever");
  assert.equal(l.status, 200);
  assert.equal(l.headers["set-cookie"], undefined);
});

test("required mode: api and stream need credentials, healthz and session stay open", async () => {
  const api = await call("/api/home");
  assert.equal(api.status, 401);
  assert.deepEqual(JSON.parse(api.body), { error: "unauthorized" });
  assert.equal((await call(`/api/video/${VID}`)).status, 401);
  assert.equal((await call("/api/nope")).status, 401, "unknown api paths do not reveal that they are unknown");
  assert.equal((await call("/api/subscribe", { method: "POST", body: "id=x" })).status, 401);
  assert.equal((await call("/healthz")).status, 200);
  assert.equal((await call("/healthz")).body, "ok");
  assert.deepEqual(JSON.parse((await call("/api/session")).body), { auth: "required", authenticated: false });
});

test("the stream is authorised before yt-dlp or ffmpeg is spawned", async () => {
  const r = await call(`/stream/${VID}`);
  assert.equal(r.status, 401);
  assert.equal((await call(`/stream/${VID}?t=5`, { headers: bearerHdr("nope") })).status, 401);
  await new Promise((r2) => setTimeout(r2, 150));
  assert.equal(existsSync(join(tmp, "ytdlp.ran")), false, "yt-dlp must not run");
  assert.equal(existsSync(process.env.PIDFILE!), false, "ffmpeg must not run");
});

test("bearer token works, wrong or malformed ones do not", async () => {
  assert.equal((await call("/api/home", { headers: bearerHdr(TOKEN) })).status, 200);
  assert.equal((await call("/api/home", { headers: { authorization: `bearer ${TOKEN}` } })).status, 200);
  assert.equal((await call("/api/home", { headers: bearerHdr(TOKEN + "x") })).status, 401);
  assert.equal((await call("/api/home", { headers: bearerHdr(TOKEN.slice(0, -1)) })).status, 401);
  assert.equal((await call("/api/home", { headers: { authorization: TOKEN } })).status, 401);
  assert.equal((await call("/api/home", { headers: { authorization: `Basic ${TOKEN}` } })).status, 401);
  assert.equal((await call("/api/home", { headers: bearerHdr("") })).status, 401);
  assert.deepEqual(JSON.parse((await call("/api/session", { headers: bearerHdr(TOKEN) })).body), { auth: "required", authenticated: true });
});

test("cookie login: JSON and form, cookie flags, cookie authorises api and stream, never contains the token", async () => {
  const r = await login(TOKEN);
  assert.equal(r.status, 200);
  const raw = String(r.headers["set-cookie"]);
  assert.match(raw, /^yt_session=\d+\.[0-9a-f]{64};/);
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Max-Age=2592000/);
  assert.doesNotMatch(raw, /Secure/, "plain http must not get a Secure cookie (the browser would drop it)");
  assert.ok(!raw.includes(TOKEN));
  const cookie = cookieOf(r);
  assert.equal((await call("/api/home", { headers: { cookie } })).status, 200);
  assert.deepEqual(JSON.parse((await call("/api/session", { headers: { cookie } })).body), { auth: "required", authenticated: true });
  const s = await call(`/stream/${VID}`, { headers: { cookie } });
  assert.notEqual(s.status, 401);
  const form = await call("/api/login", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `token=${encodeURIComponent(TOKEN)}` });
  assert.equal(form.status, 200);
});

test("the cookie is Secure only over https (X-Forwarded-Proto)", async () => {
  assert.match(String((await login(TOKEN, { "x-forwarded-proto": "https" })).headers["set-cookie"]), /; Secure/);
});

test("wrong login token is 401 with no cookie; forged, expired and other-token cookies are rejected", async () => {
  const bad = await login("wrong");
  assert.equal(bad.status, 401);
  assert.equal(bad.headers["set-cookie"], undefined);
  assert.equal((await login("")).status, 401);
  assert.equal((await call("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" })).status, 401);
  const good = cookieOf(await login(TOKEN));
  const forged = good.slice(0, -1) + (good.endsWith("0") ? "1" : "0");
  assert.equal((await call("/api/home", { headers: { cookie: forged } })).status, 401);
  assert.equal((await call("/api/home", { headers: { cookie: `yt_session=${makeSession(sessionKey("another-token-0123456789"))}` } })).status, 401);
  assert.equal((await call("/api/home", { headers: { cookie: `yt_session=${makeSession(sessionKey(TOKEN), Date.now() - 31 * 24 * 3600 * 1000)}` } })).status, 401);
  assert.equal((await call("/api/home", { headers: { cookie: `yt_session=${TOKEN}` } })).status, 401, "the raw token is not a session");
  assert.equal((await call("/api/home", { headers: { cookie: `yt_session=junk; ${good}` } })).status, 200, "a stale duplicate does not hide a valid cookie");
  process.env.ACCESS_TOKEN = "rotated-token-0123456789";
  assert.equal((await call("/api/home", { headers: { cookie: good } })).status, 401, "rotating the token ends every session");
});

test("rate limit: 10 failures then 429 with Retry-After, also blocks the right token; recovers after the window", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await login("wrong" + i)).status, 401);
  const blocked = await login("wrong");
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers["retry-after"]) > 0);
  assert.equal((await login(TOKEN)).status, 429, "a correct token is refused while locked, or guessing would stay possible");
  assert.equal((await call("/api/home", { headers: bearerHdr(TOKEN) })).status, 429);
  assert.equal((await call("/api/session", { headers: bearerHdr("x") })).status, 429);
  await boot(); // stands in for the window passing (the window arithmetic is unit-tested below)
  assert.equal((await login(TOKEN)).status, 200);
});

test("wrong bearer tokens count towards the limit too", async () => {
  for (let i = 0; i < 10; i++) assert.equal((await call("/api/home", { headers: bearerHdr("w" + i) })).status, 401);
  assert.equal((await call("/api/home", { headers: bearerHdr("w") })).status, 429);
  assert.equal((await call("/api/home")).status, 401, "requests without credentials are not counted or blocked");
});

test("limiter window arithmetic", () => {
  const l = failureLimiter(3, 1000);
  for (let i = 0; i < 3; i++) l.fail("a", 0);
  assert.equal(l.blockedFor("a", 500), 1);
  assert.equal(l.blockedFor("b", 500), 0);
  assert.equal(l.blockedFor("a", 1000), 0);
  const small = failureLimiter(1, 1000, 2);
  small.fail("1", 0);
  small.fail("2", 0);
  small.fail("3", 0); // cap on tracked keys: oldest evicted, no unbounded growth
  assert.equal(small.blockedFor("1", 1), 0);
  assert.equal(small.blockedFor("3", 1) > 0, true);
});

test("logout clears the cookie; cross-site login and logout are refused", async () => {
  const out = await call("/api/logout", { method: "POST" });
  assert.equal(out.status, 200);
  assert.match(String(out.headers["set-cookie"]), /^yt_session=;.*Max-Age=0/);
  const form = await call("/api/logout", { method: "POST", headers: { accept: "text/html,application/xhtml+xml", origin: `http://127.0.0.1:${port}` } });
  assert.equal(form.status, 303);
  assert.equal(form.headers.location, "/login");
  assert.match(String(form.headers["set-cookie"]), /Max-Age=0/);
  const evil = { origin: "https://evil.example" };
  assert.equal((await login(TOKEN, evil)).status, 403);
  assert.equal((await call("/api/logout", { method: "POST", headers: evil })).status, 403);
  assert.equal((await call("/api/login", { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: "token=x" })).status, 403);
});

test("ALLOWED_HOSTS still applies, and CORS stays closed", async () => {
  process.env.ALLOWED_HOSTS = "only.example";
  assert.equal((await call("/api/home", { headers: bearerHdr(TOKEN) })).status, 421);
  delete process.env.ALLOWED_HOSTS;
  const r = await call("/api/home", { headers: { ...bearerHdr(TOKEN), origin: "https://evil.example" } });
  assert.equal(r.headers["access-control-allow-origin"], undefined);
});

test("constant-time helpers and header parsing edge cases", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual("", "a"), false);
  assert.equal(safeEqual("", ""), true);
  assert.equal(safeEqual("é".repeat(100), "e".repeat(200)), false);
  assert.equal(bearer("Bearer abc"), "abc");
  assert.equal(bearer("bearer   abc  "), "abc");
  assert.equal(bearer("Bearer"), null);
  assert.equal(bearer("Bearer a b"), null);
  assert.equal(bearer("Bearer " + "x".repeat(600)), null);
  assert.equal(bearer(undefined), null);
  assert.deepEqual(cookieValues("a=1; yt_session=x; b=2; yt_session=y", "yt_session"), ["x", "y"]);
  assert.deepEqual(cookieValues("xyt_session=1; yt_session2=2; noequals", "yt_session"), []);
  assert.equal(validSession("k", "garbage"), false);
  assert.equal(validSession("k", makeSession("k")), true);
  assert.equal(validSession("k", makeSession("k").replace(/^\d+/, "99999999999")), false, "expiry is covered by the signature");
  const now = 1_700_000_000_000;
  const edge = makeSession("k", now - 30 * 24 * 3600 * 1000 + 5000); // expires 5 s from "now"
  assert.equal(validSession("k", edge, now), true);
  assert.equal(validSession("k", edge, now + 4999), true);
  assert.equal(validSession("k", edge, now + 5000), false, "expired exactly at the boundary");
  assert.equal(validSession("k", "0" + makeSession("k")), false, "leading zero in the expiry");
  assert.equal(validSession("k", makeSession("k").replace(/^(\d+)\./, "$1 .")), false);
});

test("the token never appears in any response body, header or log line", async () => {
  const responses: Res[] = [
    await call("/api/home"),
    await call("/api/home", { headers: bearerHdr(TOKEN + "x") }),
    await call("/api/session"),
    await login("wrong"),
    await login(TOKEN),
    await call("/api/home", { headers: bearerHdr(TOKEN) }),
    await call(`/stream/${VID}`),
    await call("/api/logout", { method: "POST" }),
  ];
  for (const r of responses) {
    assert.ok(!r.body.includes(TOKEN) && !JSON.stringify(r.headers).includes(TOKEN));
  }
  assert.ok(logged.length > 0, "the server logged requests");
  assert.ok(!logged.includes(TOKEN) && !logged.includes("wrong"), "logs must not contain tokens");
});

test("the cookie key is independent of the token alone: it needs the persisted random secret", () => {
  const key = sessionKey(TOKEN);
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.equal(sessionKey(TOKEN), key, "stable, so sessions survive a restart");
  assert.notEqual(sessionKey(TOKEN + "x"), key, "rotating the token changes the key");
  const row = getDb().prepare("SELECT value FROM meta WHERE key = 'session_secret'").get() as { value: string };
  assert.match(row.value, /^[0-9a-f]{64}$/);
  const cookie = makeSession(key);
  // An offline attacker who only knows the token cannot forge: HMAC keyed by the bare token does not validate.
  assert.equal(validSession(TOKEN, cookie), false);
  assert.equal(validSession(key, cookie), true);
  // A different secret (a fresh database) invalidates old cookies even with the same token.
  getDb().prepare("UPDATE meta SET value = ? WHERE key = 'session_secret'").run("f".repeat(64));
  const other = sessionKey(TOKEN);
  assert.equal(other, key, "the secret is cached per connection; changing the row needs a reopen");
  getDb().prepare("UPDATE meta SET value = ? WHERE key = 'session_secret'").run(row.value);
});

test("token validation and start-up configuration", () => {
  assert.equal(tokenProblem("a".repeat(16)), null);
  assert.equal(tokenProblem("a".repeat(512)), null);
  assert.match(tokenProblem("a".repeat(15))!, /too short/);
  assert.match(tokenProblem("a".repeat(513))!, /too long/);
  for (const bad of ["has space in it 1234", "comma,comma,comma,1", "tab\tcharacter-1234567", "unicodé-token-123456", "new\nline-token-123456"]) {
    assert.match(tokenProblem(bad)!, /printable ASCII/, JSON.stringify(bad));
  }
  assert.equal(tokenProblem(TOKEN), null);
  // Any accepted token round-trips through the Bearer parser.
  assert.equal(bearer(`Bearer ${"~!#$%&'()*+-./:;<=>?@[]^_`{|}0123456789abc"}`), "~!#$%&'()*+-./:;<=>?@[]^_`{|}0123456789abc");
  assert.equal(checkAuthConfig({}), "open");
  assert.equal(checkAuthConfig({ ACCESS_TOKEN: "" }), "open");
  assert.equal(checkAuthConfig({ ACCESS_TOKEN: TOKEN }), "token");
  assert.throws(() => checkAuthConfig({ ACCESS_TOKEN: "short" }), /too short/);
  assert.throws(() => checkAuthConfig({ REQUIRE_AUTH: "1" }), /REQUIRE_AUTH/);
  assert.throws(() => checkAuthConfig({ REQUIRE_AUTH: "1", ACCESS_TOKEN: "" }), /REQUIRE_AUTH/);
  assert.equal(checkAuthConfig({ REQUIRE_AUTH: "1", ACCESS_TOKEN: TOKEN }), "token");
  assert.equal(checkAuthConfig({ REQUIRE_AUTH: "0" }), "open");
});

test("server.ts refuses to start on a bad configuration", async () => {
  const run = (env: Record<string, string>) =>
    promisify(execFile)(process.execPath, ["--experimental-strip-types", "--no-warnings", join(import.meta.dirname, "server.ts")], {
      env: { PATH: process.env.PATH, DATA_DIR: join(tmp, "data2"), PORT: "0", ...env }, timeout: 5000,
    }).then(() => ({ code: 0, err: "" }), (e: { code: number; stderr: string }) => ({ code: e.code, err: e.stderr }));
  const short = await run({ ACCESS_TOKEN: "short" });
  assert.equal(short.code, 1);
  assert.match(short.err, /REFUSING TO START.*too short/);
  const req = await run({ REQUIRE_AUTH: "1" });
  assert.equal(req.code, 1);
  assert.match(req.err, /REQUIRE_AUTH/);
});

test("path and method matrix: nothing is served or spawned without credentials", async () => {
  const paths = ["/api/home", "//api/home", "/api/../api/home", "/API/home", "/api/home/", "/%61pi/home", "/api/%2e%2e/api/home", "/stream/..", `/stream/${VID}`, `/stream/${VID}/`, `/stream//${VID}`, "/stream/%41AAAAAAAAAA", "/api", "/api/", "/api/login/", "/api/session/x", `/api/video/${VID}`];
  for (const method of ["GET", "HEAD", "OPTIONS", "POST", "DELETE", "PUT"]) {
    for (const p of paths) {
      const r = await call(p, { method });
      if (/^\/(api|stream)\//.test(new URL(p, "http://x").pathname)) assert.equal(r.status, 401, `${method} ${p}`);
      assert.ok(!r.body.includes(`"feed":`) && !r.body.includes(`"subs":`), `${method} ${p} leaked data`);
    }
  }
  await new Promise((r2) => setTimeout(r2, 150));
  assert.equal(existsSync(join(tmp, "ytdlp.ran")), false, "yt-dlp must not run");
  assert.equal(existsSync(process.env.PIDFILE!), false, "ffmpeg must not run");
  assert.equal((await call("/api/home", { method: "GET" })).status, 401);
  assert.equal((await call("/api/home/", { method: "DELETE" })).status, 401);
  const root = await call("/stream/..");
  assert.match(root.body, /<!doctype html>|not found/i, "normalised to / (a public static page), never data");
});

test("global cap, huge and duplicate Cookie headers, limiter key eviction", async () => {
  // 200 failures spread over many (spoofed) clients trip the global cap for everyone.
  for (let i = 0; i < 200; i++) await call("/api/home", { headers: { ...bearerHdr("w"), "x-forwarded-for": `10.0.${i >> 8}.${i & 255}` } });
  assert.equal((await call("/api/home", { headers: { ...bearerHdr("w"), "x-forwarded-for": "10.9.9.9" } })).status, 429);
  assert.equal((await login(TOKEN, { "x-forwarded-for": "10.8.8.8" })).status, 429);
  const good = cookieOf(await (async () => { await boot(); return login(TOKEN); })());
  assert.equal((await call("/api/home", { headers: { cookie: "yt_session=x; ".repeat(900) + good } })).status, 401, "only the first few duplicates are examined");
  assert.equal((await call("/api/home", { headers: { cookie: "yt_session=x; " + good } })).status, 200);
  assert.equal((await call("/api/home", { headers: { cookie: "a=" + "b".repeat(8000) } })).status, 401);
  const small = failureLimiter(1, 1000, 3);
  for (let i = 0; i < 50; i++) small.fail(`k${i}`, 0);
  assert.ok(small.size() <= 3, "key table stays bounded");
});

test("an authorised or refused stream never redirects (the token can't follow a redirect)", async () => {
  const refused = await call(`/stream/${VID}`);
  assert.equal(refused.headers.location, undefined);
  const ok = await call(`/stream/${VID}`, { headers: bearerHdr(TOKEN) });
  assert.equal(ok.headers.location, undefined);
  assert.ok(ok.status < 300 || ok.status >= 400);
});

test("safeNext only ever returns a same-origin path", () => {
  const rejected = ["//x", "//evil.com", "/\\x", "/\\/x", "/\t/x", "/\n/evil.com", "/\r/evil.com", "/%09/x", "/%0a/evil.com", "/%5cx", "/%5Cx", "/ x", "javascript:alert(1)", "https://evil.com", "http://127.0.0.1/x", "evil.com", "", null, undefined, "x", "/\u0000", "/" + "a".repeat(2001)];
  for (const r of rejected) assert.equal(safeNext(r), "/", `${JSON.stringify(r)?.slice(0, 40)} must fall back to /`);
  assert.equal(safeNext("/ok?q=1"), "/ok?q=1");
  assert.equal(safeNext("/watch?v=abc"), "/watch?v=abc");
  assert.equal(safeNext("/watch?v=abc&t=5#x"), "/watch?v=abc&t=5#x");
  assert.equal(safeNext("/channel/UCabc"), "/channel/UCabc");
  assert.equal(safeNext("/"), "/");
  // Through the real query-string decoding ("%09" becomes a TAB before it reaches safeNext).
  for (const evil of ["/%09/evil.com", "/%0a/evil.com", "//evil.com", "/%5cevil.com"]) {
    assert.equal(safeNext(new URLSearchParams(`next=${evil}`).get("next")), "/", evil);
  }
});

test("browser form login: 303 to the validated next page with the cookie; wrong token goes back with #bad; JSON clients unaffected", async () => {
  const form = (token: string, qs = "") =>
    call(`/api/login${qs}`, { method: "POST", headers: { accept: "text/html", "content-type": "application/x-www-form-urlencoded", origin: `http://127.0.0.1:${port}` }, body: `token=${encodeURIComponent(token)}` });
  const ok = await form(TOKEN, "?next=%2Fwatch%3Fv%3Dabc");
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.location, "/watch?v=abc");
  assert.match(String(ok.headers["set-cookie"]), /^yt_session=\d+\.[0-9a-f]{64}; .*HttpOnly.*SameSite=Strict/);
  for (const evil of ["//evil.com", "/%09/evil.com", "https://evil.com", "/%5cevil.com"]) {
    assert.equal((await form(TOKEN, `?next=${encodeURIComponent(evil.startsWith("/%") ? decodeURIComponent(evil) : evil)}`)).headers.location, "/", evil);
    assert.equal((await form(TOKEN, `?next=${evil}`)).headers.location, "/", evil);
  }
  const bad = await form("nope", "?next=%2Fhistory");
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.location, "/login?next=%2Fhistory#bad");
  assert.equal(bad.headers["set-cookie"], undefined);
  assert.equal((await form("nope")).headers.location, "/login#bad");
  assert.equal((await login("nope")).status, 401, "a JSON client still gets a status code");
  for (let i = 0; i < 10; i++) await form("nope" + i);
  assert.equal((await form(TOKEN)).headers.location, "/login#locked");
});

test("every playlist route is behind the gate: 401 without or with a wrong token, reachable with the right one", async () => {
  const form = { "content-type": "application/x-www-form-urlencoded" };
  const routes: [string, string, string][] = [
    ["GET", "/api/playlists", ""],
    ["POST", "/api/playlists", "name=x"],
    ["GET", "/api/playlists/membership?ids=" + VID, ""],
    ["GET", "/api/playlists/1", ""],
    ["POST", "/api/playlists/2/rename", "name=y"],
    ["DELETE", "/api/playlists/2", ""],
    ["POST", "/api/playlists/1/items", `id=${VID}`],
    ["DELETE", `/api/playlists/1/items/${VID}`, ""],
    ["POST", "/api/playlists/1/move", `id=${VID}&index=0`],
  ];
  for (const [method, path, body] of routes) {
    for (const hdr of [{}, bearerHdr("wrong-token-0123456789")]) {
      const r = await call(path, { method, headers: { ...form, ...hdr }, body: body || undefined });
      assert.equal(r.status, 401, `${method} ${path}`);
    }
    const ok = await call(path, { method, headers: { ...form, ...bearerHdr(TOKEN) }, body: body || undefined });
    assert.notEqual(ok.status, 401, `${method} ${path} with the token`);
  }
  assert.equal((await call("/api/playlists", { headers: bearerHdr(TOKEN) })).status, 200);
});
