import { createApp } from "./app.ts";
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
