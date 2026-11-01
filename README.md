# YouTube Classic

A personal, self-hosted YouTube frontend that recreates the look of "classic" YouTube (roughly 2009–2012) and
ships **almost no JavaScript**. Pages are rendered on the server as plain HTML. The only script is a small seek bar
(`frontend/public/player.js`) on the watch page; every other page has none.

Video and metadata still come from Google/YouTube. Only the frontend is yours.

> **Personal project, not for public use.** It plays video by extracting stream URLs with
> [yt-dlp](https://github.com/yt-dlp/yt-dlp) and uses an unofficial YouTube endpoint for related videos. That is
> against YouTube's Terms of Service and can break whenever YouTube changes something. Run it privately on your own
> network, for yourself. Don't expose it to the internet.

## Features

- **Subscriptions home page**: merged feed of your subscribed channels (from their RSS feeds, no API quota), with
  view counts, plus a "Recommended for you" row.
- **Search**: classic results list, paged, using yt-dlp (no API quota).
- **Watch page**: playback in a plain `<video>` tag, a related-videos list, quality links (360/480/720/1080p) and a seek bar.
- **Channel pages**: banner, uploads grid, Subscribe/Unsubscribe (stored locally, no Google login).
- **Audio language**: prefers English audio on auto-dubbed videos; override per video with `?a=pt`.

## How it works

```
browser ──► nginx (frontend container) ──► Node/TypeScript backend (backend container)
              serves /static/*                 ├─ YouTube Data API v3   video + channel metadata
              proxies everything else          ├─ yt-dlp                search + stream URL resolution
                                               ├─ ffmpeg                live remux of video+audio to mp4
                                               ├─ YouTube RSS feeds     subscriptions feed
                                               └─ YouTube /next         related videos + recommendations
```

- **`backend/`** renders every HTML page (plain template literals, no framework) and streams video.
- **`frontend/`** is static CSS/JS, served by nginx, which also reverse-proxies all other requests to the backend.
- **Playback:** YouTube no longer offers a single file with audio and video together, so the backend takes the
  separate video and audio streams and has ffmpeg combine them *on the fly* into fragmented mp4. Nothing is
  downloaded or cached, and playback starts in a couple of seconds. Because a live stream has no fixed length, the
  browser's own seek bar can't work on it. The small `player.js` shows the real duration (from the API) and restarts
  the stream at `?t=<seconds>` when you seek outside what has buffered.
- **Subscriptions** are stored in `DATA_DIR/subscriptions.json` (default `backend/data/`).

## Requirements

- [Podman](https://podman.io/) with `podman-compose` (or adapt `compose.yaml` for Docker; the Containerfiles are standard).
- A YouTube Data API key (free, see below).
- For development without containers: Node.js 22.9+, `yt-dlp` (recent; old releases break often) and `ffmpeg`.
  A [Nix](https://nixos.org/) `shell.nix` with all of these is included.

## Getting a YouTube Data API key

The key is used for video details (the watch page) and channel pages. Search normally does **not** use it (it uses yt-dlp); it only falls back to the API, at 100 quota units per search, if yt-dlp fails.

1. Go to <https://console.cloud.google.com/> and sign in with any Google account.
2. Create a project: use the project dropdown at the top, choose **New Project**, and name it (for example `yt-classic`).
3. Enable the API: **APIs & Services → Library**, search for **YouTube Data API v3**, click **Enable**.
4. Create the key: **APIs & Services → Credentials → Create credentials → API key**. Copy it.
5. Restrict the key (recommended): click the key, then under **API restrictions** choose **Restrict key** and select
   **YouTube Data API v3**. Optionally add an **IP address restriction** with the public IP of the machine that runs the
   backend.
   - If you use an IP restriction, remember Google sees the address your server connects from. If your machine has
     **IPv6**, that is often the address that gets used, so allowlist it (and your IPv4 address) or the API will answer
     `403: The provided API key has an IP address restriction`.
   - Changes can take a few minutes to apply, and don't forget to click **Save**.

The default quota is 10,000 units per day. Video, channel and playlist lookups cost 1 unit each, so normal use stays
far below that. Responses are cached in memory for 10 minutes to 1 hour.

## Quick start (containers)

```bash
git clone https://github.com/dodwmd/yt-classic.git
cd yt-classic

cp backend/.env.example backend/.env
# edit backend/.env and set YT_API_KEY=<your key>

mkdir -p backend/data      # subscriptions live here; must be writable by your user
podman-compose up -d --build
```

Open <http://localhost:8080>. Subscribe to a channel (search for a video, open its channel, click **Subscribe**) and
your home page will fill with that channel's uploads.

```bash
podman-compose logs -f backend   # watch the backend log
podman-compose down              # stop and remove the containers
```

Subscriptions are kept in `backend/data/subscriptions.json` (mounted into the container), so they survive rebuilds.
It is the one file worth backing up. If it is ever damaged, the backend moves it aside as
`subscriptions.json.corrupt-<time>` and starts with an empty list instead of failing.

**Hardening.** The backend runs as a non-root user with a read-only root filesystem, no Linux capabilities, and
memory/process limits. nginx is the non-root `nginx-unprivileged` image and sets a Content-Security-Policy and
related headers. Both base images are pinned by digest.

**yt-dlp** is pinned and checksum-verified in `backend/Containerfile` (`YTDLP_VERSION`, `YTDLP_SHA256`); the
container never updates it at runtime. When YouTube breaks playback, bump both values (the checksum is in the
release's `SHA2-256SUMS`), keep `shell.nix` in step, and rebuild. The backend logs the yt-dlp version at start.

**Network exposure.** `compose.yaml` publishes port 8080 on all interfaces. To limit it, change the mapping to
`"127.0.0.1:8080:8080"` or your LAN address. Set `ALLOWED_HOSTS` (below) to guard against DNS-rebinding. The app has
no login, so keep it on a network you trust.

**Starting at boot (rootless podman).** `restart: unless-stopped` does not bring containers back after a reboot by
itself. Enable `systemctl --user enable --now podman-restart.service` (and `loginctl enable-linger $USER`), or
generate systemd units.

**Docker.** The compose file uses `userns_mode: keep-id` so the bind-mounted `backend/data` is writable by your user
under rootless podman. That key is podman-specific; for Docker remove it, and make `backend/data` writable by
uid 1000.

## Development

With Nix (provides Node 22, a pinned recent yt-dlp, ffmpeg, podman, podman-compose, and curl/jq/htmlq/git for debugging):

```bash
nix-shell
cd backend
npm install
cp .env.example .env     # then add your key
npm run dev              # http://localhost:3000, restarts on changes
```

Without Nix, install Node 22+, yt-dlp and ffmpeg yourself and run the same commands. In dev, the backend also serves
`frontend/public/` at `/static/`, so you don't need nginx.

```bash
npm run check       # typecheck + lint + tests (what CI runs)
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint (typescript-eslint), including no-floating-promises
npm test            # node:test with fake yt-dlp/ffmpeg binaries and a stubbed API; no network
```

Node runs the TypeScript directly (`--experimental-strip-types`), so there is no build step.

Two TypeScript versions are installed on purpose: type checking (`npm run typecheck`) runs on **TypeScript 7**
(the `typescript-7` alias in `backend/package.json`), while the plain `typescript` 5.x package exists only as
ESLint's parser, because typescript-eslint does not support TypeScript 7 yet. When it does, drop the alias and the
Dependabot ignore rule in `.github/dependabot.yml`.

`shell.nix` also picks up an optional, git-ignored `shell.local.nix` for personal tools. It is a function from `{ pkgs }` to a list of packages, for example `{ pkgs }: [ pkgs.ripgrep ]`.

To update yt-dlp in the dev shell, bump `ytDlpVersion` and its `sha256` in `shell.nix` (the command is in the comment there).

## Configuration

Environment variables, read from `backend/.env` in dev and in compose:

| Variable | Default | Purpose |
|---|---|---|
| `YT_API_KEY` | none (required) | YouTube Data API v3 key |
| `AUDIO_LANG` | `en` | Preferred audio language when a video has several dubbed tracks |
| `PORT` | `3000` | Backend listen port |
| `DATA_DIR` | `./data` (`/data` in the container) | Where `subscriptions.json` is stored |
| `ALLOWED_HOSTS` | unset (any) | Comma-separated `Host` header values to accept, e.g. `192.168.1.10:8080`; others get 421 |
| `MAX_STREAMS` | `3` | Concurrent video streams; extra requests get 503 |
| `STREAM_MAX_SECONDS` | `21600` | Hard cap on one stream's duration |
| `SEARCH_FALLBACK_MAX` | `20` | Daily cap on search falling back to the Data API (100 quota units each) |

URL parameters on the watch page: `q` (quality: 360, 480, 720, 1080), `t` (start offset in seconds), `a` (audio
language code such as `pt`). For example `/watch?v=VIDEO_ID&q=1080&t=90`.

## Limitations

- **Seeking** outside the already-buffered part restarts the stream (about 1–2 seconds). There is no seek preview.
- **Related videos and recommendations** use YouTube's unofficial `/next` endpoint. If it stops working, the watch
  page falls back to "More from this channel" (1 quota unit); the recommendations row simply disappears.
- **Search results** have no upload date, because the free yt-dlp search doesn't return one.
- **Comments, playlists, login, live streams and Shorts-specific pages** are not implemented.
- Everything depends on yt-dlp keeping up with YouTube. If playback stops working, update yt-dlp first.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Error page: `YouTube API … 403 … IP address restriction` | The key is restricted to other IPs. Add the address named in the error to the key's restrictions, or remove the IP restriction. |
| `YT_API_KEY is not set` | Create `backend/.env` from `backend/.env.example`. |
| Video won't start, or `/stream/…` returns 502 | yt-dlp is out of date or YouTube changed. Bump the pinned yt-dlp in `backend/Containerfile` and rebuild (`podman-compose up -d --build`). Check `podman-compose logs backend`; it prints the yt-dlp version at start. A 503 means all `MAX_STREAMS` slots are busy. |
| Wrong audio language on a dubbed video | Set `AUDIO_LANG`, or add `&a=<code>` to the watch URL. |
| Feed missing some channels | YouTube's RSS endpoint is occasionally flaky; the backend retries and skips channels that fail. Reload. |
| Old styling after an update | Hard refresh (Ctrl+Shift+R) once. Static files are served with `no-cache` and revalidate after that. |

## CI/CD

GitHub Actions, in `.github/workflows/`:

- **`ci.yml`** runs on **pull requests to `main` only** (not on pushes to `main`). Jobs: lint + typecheck + tests;
  CodeQL static analysis; security (gitleaks over the full history, `npm audit`, dependency review, hadolint on the
  Containerfiles); and `docker compose build`.
- **`cd.yml`** is a placeholder (manual trigger, does nothing). There is no deployment target yet.
- Dependabot proposes weekly updates for npm packages and the actions themselves.

Run the same checks locally (lint, types, tests) with `nix-shell --run 'cd backend && npm run check'`.

Because CI only runs on pull requests, changes pushed straight to `main` are not checked. To make the checks
binding, protect `main` (Settings → Branches → require a pull request and the CI jobs to pass).

## Project layout

```
backend/
  src/server.ts          routes and request handling
  src/yt/api.ts          YouTube Data API client
  src/yt/dlp.ts          yt-dlp URL resolution + live ffmpeg remux
  src/yt/search.ts       yt-dlp search (Data API fallback)
  src/yt/innertube.ts    related videos from YouTube's /next
  src/yt/rss.ts          channel RSS feeds
  src/recs.ts            recommendations
  src/store.ts           subscriptions.json
  src/views/*.ts         HTML templates
frontend/
  public/classic.css     the classic look
  public/player.js       the seek bar (watch page only)
  nginx.conf             static files + reverse proxy
compose.yaml             runs both containers
shell.nix                dev shell
```

## License

[0BSD](LICENSE) (BSD Zero Clause): do whatever you like with this code, with no conditions and no need to keep any
notice. It comes with no warranty. This covers the code in this repository only, not YouTube's content or terms, and
not yt-dlp or ffmpeg, which have their own licenses.
