import { createApp } from "./app.ts";
import { checkAuthConfig } from "./auth.ts";
import { execFile } from "node:child_process";
import { killChildren } from "./yt/dlp.ts";
import { closeDb, getDb } from "./db.ts";

// Open (and migrate / import) eagerly so a problem shows at start-up, not on the first request. Not fatal:
// /healthz reports 503 while it is broken, and later requests retry the open.
try {
  getDb();
} catch (e) {
  console.error(`DATABASE UNAVAILABLE at start-up: ${(e as Error).message}`);
}

try {
  if (checkAuthConfig(process.env) === "token") console.log("ACCESS_TOKEN is set: /api and /stream require it.");
  else {
    console.log("ACCESS_TOKEN is not set: the API and streams are open to anyone who can reach this port. Keep it on a network you trust.");
    if (process.env.ACCESS_TOKEN === "") console.warn("WARNING: ACCESS_TOKEN is set but EMPTY, so authentication is OFF. Remove the line or give it a value (set REQUIRE_AUTH=1 to refuse to start like this).");
  }
} catch (e) {
  console.error(`REFUSING TO START: ${(e as Error).message}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 3000);
const server = createApp();
server.listen(port, () => console.log(`backend listening on :${port}`));
if (!process.env.ALLOWED_HOSTS?.trim()) {
  console.warn("ALLOWED_HOSTS is not set: any Host header is accepted, so DNS-rebinding is not blocked. Set it to the address(es) you use.");
}
execFile(process.env.YTDLP_BIN ?? "yt-dlp", ["--version"], (err, out) =>
  console.log(err ? `yt-dlp not runnable: ${err.message}` : `yt-dlp ${out.trim()}`),
);

let shuttingDown = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${sig} received, shutting down`);
    killChildren(); // don't leave ffmpeg/yt-dlp behind
    // Final close checkpoints the WAL and stops late requests from reopening the database.
    const done = () => (closeDb(true), process.exit(0));
    server.close(done);
    server.closeAllConnections();
    setTimeout(done, 2000).unref();
  });
}
