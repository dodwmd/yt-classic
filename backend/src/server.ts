import { createApp } from "./app.ts";
import { execFile } from "node:child_process";
import { killChildren } from "./yt/dlp.ts";

const port = Number(process.env.PORT ?? 3000);
const server = createApp();
server.listen(port, () => console.log(`backend listening on :${port}`));
execFile(process.env.YTDLP_BIN ?? "yt-dlp", ["--version"], (err, out) =>
  console.log(err ? `yt-dlp not runnable: ${err.message}` : `yt-dlp ${out.trim()}`),
);

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    killChildren(); // don't leave ffmpeg/yt-dlp behind
    server.close(() => process.exit(0));
    server.closeAllConnections();
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
