# YouTube Classic

A personal, self-hosted YouTube frontend that recreates the look of "classic" YouTube (roughly 2009–2012) and
keeps its JavaScript **small and purposeful**. All the HTML lives in `frontend/` as plain pages with `<template>`
blocks; a few hundred lines of vanilla JS (about 6 KB gzipped in total) fetch JSON from the backend and fill those
templates in. No framework, no bundler, no third-party scripts, no tracking. The JS size and safety rules are
enforced by tests (see [CI/CD](#cicd)). There is also a native [Android app](#android-app) that talks to the same
backend.

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
              static HTML/CSS/JS               ├─ YouTube Data API v3   video + channel metadata
              proxies /api and /stream         ├─ yt-dlp                search + stream URL resolution
                                               ├─ ffmpeg                live remux of video+audio to mp4
                                               ├─ YouTube RSS feeds     subscriptions feed
                                               └─ YouTube /next         related videos + recommendations
```

- **`backend/`** is a JSON API (`/api/home`, `/api/search`, `/api/video/:id`, `/api/channel/:id`, subscribe and
  unsubscribe) plus the video stream (`/stream/:id`). It contains no HTML.
- **`frontend/`** is everything the browser gets: `index.html`, `results.html`, `watch.html`, `channel.html`, the CSS,
  and the small JS modules in `public/js/`. nginx serves it and proxies `/api/` and `/stream/` to the backend.
  Data is put into pages with `textContent` and property assignment only, never as HTML strings.
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
`frontend/public/` (pages at `/`, `/results`, `/watch`, `/channel/<id>`, assets at `/static/`), so you don't need nginx.

```bash
npm run check       # typecheck + lint + tests (what CI runs); the frontend has its own: cd ../frontend && npm run check
npm run typecheck   # tsc --noEmit
npm run lint        # oxlint (type-aware), including no-floating-promises
npm test            # node:test with fake yt-dlp/ffmpeg binaries and a stubbed API; no network
```

Node runs the TypeScript directly (`--experimental-strip-types`), so there is no build step.

Type checking uses **TypeScript 7** (`tsc`, the native compiler). Linting uses **oxlint** with its type-aware rules
(backed by the same native compiler) rather than ESLint, because typescript-eslint does not support TypeScript 7 yet.

`shell.nix` also picks up an optional, git-ignored `shell.local.nix` for personal tools. It is a function from `{ pkgs }` to a list of packages, for example `{ pkgs }: [ pkgs.ripgrep ]`.

To update yt-dlp in the dev shell, bump `ytDlpVersion` and its `sha256` in `shell.nix` (the command is in the comment there).

## Android app

`android/` is a native Kotlin + Jetpack Compose app that uses the same backend API as the web frontend: home feed,
search, watch (with the seek bar), channel pages and subscribe/unsubscribe. Playback uses Media3/ExoPlayer.

**Build and install** (the Android SDK is large, so it has its own Nix shell, separate from the root one):

```bash
nix-shell android/shell.nix                       # JDK 17, the SDK (platform 37), adb
cd android && ./gradlew :app:assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

CI also builds the debug APK on pull requests that touch `android/` and attaches it to the run as an artifact.

**First launch:** open Settings (the gear) and enter the backend's address, for example `192.168.1.153:8080` on home
Wi-Fi, or its VPN host name when you're away, then **Test connection** and **Save**. The app uses plain `http://`
(cleartext is allowed for this reason) and the backend has no login, so only use networks you trust.

**How it works:** the backend's video stream is a live remux that can't be seeked, so the app knows the real duration
from the API and *restarts* the stream at `?t=<seconds>` when you drag the seek bar or change quality (the web
player does the same). Expect a second or two of buffering after a seek.

**Releases:** every merge to `main` publishes a signed release APK to
[GitHub Releases](../../releases) (`cd.yml`, tag `v<versionName>-<run number>`). Download it on your phone and allow
"Install unknown apps" for your browser. All releases are signed with the same key, so each one installs over the last.
The key comes from the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`
and `ANDROID_KEY_PASSWORD`; keep a backup of the keystore, because losing it means a new install is needed.

**Fullscreen:** the corner-brackets button next to the seek bar plays the video fullscreen and hides the system bars. On
phones it also switches to landscape; Android 16+ ignores orientation requests on large screens (smallest width of
600dp or more) and in multi-window, so there only the bars are hidden. Tap the video to hide the controls, Back to leave.

**Not in v1:** background audio, picture-in-picture, offline downloads, Play Store publishing.

**Testing it without a phone:** the shell can add an emulator (needs KVM, about 2 GB more):

```bash
nix-shell android/shell.nix --arg withEmulator true
# create an AVD once: avdmanager create avd -n yt -k 'system-images;android-36;google_apis;x86_64' -d pixel_6
emulator -avd yt -no-window -gpu swiftshader_indirect &     # drop -no-window to see it
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.dodwmd.ytclassic/.MainActivity --es server 10.0.2.2:8080   # debug builds only
```

`10.0.2.2` is the host machine as seen from the emulator. `./gradlew :app:testDebugUnitTest :app:lintDebug` runs
the unit tests (API parsing against real captured responses, formatters, seek logic) and Android lint.

**Note on the SDK:** the newest Android libraries need `compileSdk` 37, which this nixpkgs snapshot doesn't ship yet,
so `android/shell.nix` adds platform 37 from Google as a hash-pinned download. Once nixpkgs has it, that block can go.

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
| `502` from every page right after recreating the backend | nginx re-resolves the backend name every few seconds (`frontend/05-resolver.sh`), so it recovers on its own within about 5 s. If it persists, check `podman-compose logs frontend` for `05-resolver: using …` and `podman-compose logs backend`. |
| Video won't start, or `/stream/…` returns 502 | yt-dlp is out of date or YouTube changed. Bump the pinned yt-dlp in `backend/Containerfile` and rebuild (`podman-compose up -d --build`). Check `podman-compose logs backend`; it prints the yt-dlp version at start. A 503 means all `MAX_STREAMS` slots are busy. |
| Wrong audio language on a dubbed video | Set `AUDIO_LANG`, or add `&a=<code>` to the watch URL. |
| Feed missing some channels | YouTube's RSS endpoint is occasionally flaky; the backend retries and skips channels that fail. Reload. |
| Old styling after an update | Hard refresh (Ctrl+Shift+R) once. Static files are served with `no-cache` and revalidate after that. |

## CI/CD

GitHub Actions, in `.github/workflows/`:

- **`ci.yml`** runs on **pull requests to `main` only** (not on pushes to `main`). Jobs:
  - backend lint + typecheck + tests;
  - frontend lint + tests, including the **JS guardrails**: a size budget on the shipped JavaScript (8 KB gzipped),
    no HTML-injection or dynamic-code sinks, same-origin module scripts only, and a check that every element a page
    script looks up exists in its HTML;
  - CodeQL static analysis;
  - security: gitleaks over the full history, `npm audit`, dependency review, hadolint on the Containerfiles;
  - `docker compose build`;
  - Android build, unit tests and lint (only when `android/` changed), with the debug APK attached to the run.
- **`cd.yml`** is a placeholder (manual trigger, does nothing). There is no deployment target yet.
- Dependabot proposes weekly updates for the backend and frontend npm packages and for the actions themselves.

Run the same checks locally with `nix-shell --run 'cd backend && npm run check && cd ../frontend && npm run check'`.

`main` is protected: changes go through a pull request, and the CI jobs must pass before merging.

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
frontend/
  public/*.html          the pages, with <template> blocks (all of the HTML)
  public/classic.css     the classic look; follows the system light/dark setting
  public/js/             vanilla JS: lib (helpers), fmt (formatting), one module per page, player (seek bar)
  test/                  formatter tests and the JS guardrails (size budget, no unsafe sinks, same-origin only)
  nginx.conf             page routes, security headers, reverse proxy for /api and /stream (re-resolves `backend` at runtime)
  05-resolver.sh         at start, turns the container's DNS server into nginx's `resolver` line
android/                 the native Android app (Kotlin + Compose); has its own shell.nix and Gradle wrapper
compose.yaml             runs both containers
shell.nix                dev shell
```

## License

[0BSD](LICENSE) (BSD Zero Clause): do whatever you like with this code, with no conditions and no need to keep any
notice. It comes with no warranty. This covers the code in this repository only, not YouTube's content or terms, and
not yt-dlp or ffmpeg, which have their own licenses.
