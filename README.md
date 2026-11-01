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

- **Channel tabs** (web `?tab=videos|playlists|shorts|live|about`, Android tab row): Videos (uploads), Playlists (the channel's
  public playlists, each opens its videos; nothing auto-advances), Shorts (uploads of 61 s or less), Live (current,
  upcoming and past streams) and About (description, handle, join date, country, view/subscriber counts, links found in the
  description). Shorts are detected by length (61 s or less), so Shorts of up to 3 minutes are not recognised and appear
  only under Videos. Shorts and Live scan at most 3 uploads pages (2 Data API units each) per request and are cached.
  The tab routes share a Data API budget (`TAB_UNITS_MAX`, default 500 units a day) and an hourly request cap
  (`TAB_REQUESTS_PER_HOUR`, default 1200); beyond either they answer 429 with `Retry-After`. Only first pages are
  kept in the database; page tokens must match `[A-Za-z0-9_-]{1,120}`.
  `GET /api/channel/:id/playlists`, `/playlist/:playlistId` (only playlists owned by that channel), `/shorts`, `/live`
  (all take `?pageToken=`) and `/about`.
- **Subscriptions home page**: merged feed of your subscribed channels (from their RSS feeds, no API quota), with
  view counts.
- **Import and export subscriptions**: bring your YouTube subscriptions over in one step (page `/subscriptions`, or
  Settings in the Android app); see [Importing and exporting subscriptions](#importing-and-exporting-subscriptions).
- **Search**: classic results list, paged, using yt-dlp (no API quota).
- **Watch page**: playback in a plain `<video>` tag, a related-videos list, quality links (360/480/720/1080p) and a seek bar.
- **Watch history and resume**: the watch page reports your position every ~10 s (and on pause, end and leaving), so a
  video resumes where you left off across restarts and devices. The home page has a "Continue watching" row with a
  progress bar, videos watched to the end get a "Watched" badge in the feed, search, channel and related lists, and
  `/history` lists everything with Remove and "Clear all history". The Android app does the same, also while the app
  is in the background.
- **Watch later and playlists**: you build them yourself (nothing is suggested or generated). A built-in "Watch later"
  list always exists; a `+`/check toggle (44 px on touch, keyboard reachable) on every video in feed, search, channel,
  history and related lists, and a button next to the title on the watch page, adds or removes a video. `/playlists`
  lists your playlists (create, rename, delete; max 50, names up to 80 characters, unique ignoring case) and
  `/playlists?id=N` shows one (max 500 videos) with Remove, Move to top and Play, which opens the first video; there
  is no auto-advance. Title, channel and duration are copied from the server's own lookup, never from the client.
  The Android app has the same: a Watch later toggle on rows and the watch screen, Playlists and playlist screens.
- **TV mode**: lean-back playback from your subscriptions; see [TV mode](#tv-mode). Masthead "TV" on the web, "TV" on the Android home screen.
- **Channel pages**: banner, uploads grid, Subscribe/Unsubscribe (stored locally, no Google login).
- **Audio language**: prefers English audio on auto-dubbed videos; override per video with `?a=pt`.

## How it works

```
browser ──► nginx (frontend container) ──► Node/TypeScript backend (backend container)
              static HTML/CSS/JS               ├─ YouTube Data API v3   video + channel metadata
              proxies /api and /stream         ├─ yt-dlp                search + stream URL resolution
                                               ├─ ffmpeg                live remux of video+audio to mp4
                                               ├─ YouTube RSS feeds     subscriptions feed
                                               └─ YouTube /next         related videos
```

- **`backend/`** is a JSON API (`/api/home`, `/api/search`, `/api/video/:id`, `/api/channel/:id`, subscribe and
  unsubscribe, `POST /api/progress`, `GET /api/history?limit=&before=<cursor>`, `GET /api/history/watched?ids=a,b`,
  `DELETE /api/history/:id`, `POST /api/history/clear`, `GET /api/tv/next`, `GET /api/tv/status`, `GET /api/playlists`, `POST /api/playlists` (`name`), `POST /api/playlists/:id/rename`, `DELETE /api/playlists/:id`, `GET /api/playlists/:id?limit=&before=<cursor>`, `POST /api/playlists/:id/items` (`id`), `DELETE /api/playlists/:id/items/:videoId`, `POST /api/playlists/:id/move` (`id`, `index`), `GET /api/playlists/membership?ids=a,b` (max 100), `/api/subscriptions/import` and `/export`) plus the video stream (`/stream/:id`). It contains no HTML.
- **`frontend/`** is everything the browser gets: `index.html`, `results.html`, `watch.html`, `channel.html`, `subscriptions.html`, `playlists.html`, `tv.html`, `login.html`, the CSS,
  and the small JS modules in `public/js/`. nginx serves it and proxies `/api/` and `/stream/` to the backend.
  Data is put into pages with `textContent` and property assignment only, never as HTML strings.
- **Playback:** YouTube no longer offers a single file with audio and video together, so the backend takes the
  separate video and audio streams and has ffmpeg combine them *on the fly* into fragmented mp4. Nothing is
  downloaded or cached, and playback starts in a couple of seconds. Because a live stream has no fixed length, the
  browser's own seek bar can't work on it. The small `player.js` shows the real duration (from the API) and restarts
  the stream at `?t=<seconds>` when you seek outside what has buffered.
- **Storage:** subscriptions and a persistent metadata cache live in one SQLite database, `DATA_DIR/yt.db` (default
  `backend/data/`), using Node's built-in `node:sqlite` (no extra dependency).

## Importing and exporting subscriptions

Open `/subscriptions` (linked from the home page) and choose a file or paste links. In the Android app it is under
Settings > Subscriptions (system file picker, no storage permission). Over the API:

```bash
curl -X POST --data-binary @subscriptions.csv http://localhost:8080/api/subscriptions/import
# {"added":12,"existing":3,"skipped":{"invalid":0,"handles":2,"full":0},"total":15}
curl -OJ 'http://localhost:8080/api/subscriptions/export?format=opml'     # or format=csv (the default)
```

`POST /api/subscriptions/import` takes the raw file as the request body (up to 1 MB, otherwise 413; same-origin rule
as the other POST routes) and detects the format itself. The whole import is one SQLite transaction.

- **Google Takeout `subscriptions.csv`** (Takeout > YouTube > subscriptions): header `Channel ID,Channel URL,Channel title`.
  Columns are found by header name in any order; a BOM, CRLF line ends and quoted fields (commas, `""`, line breaks) are fine.
- **OPML** as in YouTube's subscription manager export: every `<outline xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UC...">`
  with its `title` (or `text`). Only the five basic XML entities and numeric references are decoded; DTD entities are never expanded.
- **A plain list**, one per line: `https://www.youtube.com/channel/UC...` URLs, feed URLs or bare `UC...` ids. Blank lines and
  lines starting with `#` are ignored. There are no titles in a list, so the channel id is shown until you open the channel.

Response: `added` (new), `existing` (already subscribed, or repeated in the file; left unchanged), `skipped.invalid` (not
a channel id), `skipped.handles` (`@handle`, `/c/` and `/user/` links: resolving those needs the Data API, so they are
skipped, not guessed), `skipped.full` (not added because the 500-subscription limit was reached) and `total` (your
subscriptions after the import). A `message` field holds the same result as one sentence for display. A body with nothing
recognisable gets 400.

`GET /api/subscriptions/export?format=csv|opml` downloads your subscriptions (`Content-Disposition: attachment`,
`subscriptions.csv` / `subscriptions.opml`) in the Takeout CSV shape or as OPML; both import back unchanged here.
nginx allows the 1 MB body only on the import route; every other route keeps the 8 KB limit.

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

**Storage.** Everything persistent is in `backend/data/yt.db` (mounted into the container), so it survives
rebuilds and restarts. It is a SQLite database in WAL mode, so next to it you will see `yt.db-wal` and `yt.db-shm`
while the backend runs. It holds:

- your **subscriptions** (the data worth backing up);
- your **watch history** (one row per video: position, duration, completed flag, last watched time, and the title and
  channel taken from the server's own metadata; at most 5000 rows, oldest pruned first);
- a **metadata cache** (channel feeds, video and channel details, related videos) that is written through to disk and
  loaded lazily after a restart, so a restart does not re-fetch every subscription's RSS feed or spend API quota.
  Entries keep their normal TTL; expired rows are pruned at start and periodically, and the table is capped at 5000
  rows and 128 MB (subscription feeds are evicted last). A `CACHE_VERSION` bump in `backend/src/cache.ts` purges rows
  written by an older data shape. Stream URLs and
  search results are never persisted. The cache is disposable: if it cannot be read or written, the backend logs it
  and carries on from memory.

The database files are created owner-only (0600; a data directory the backend creates is 0700). Schema changes are versioned migrations (`backend/src/db.ts`) applied automatically at start. (Node prints a one-line "SQLite is an experimental feature" warning in development; the container start command silences it.)

*Upgrading:* an existing `subscriptions.json` is imported automatically on first start and renamed to
`subscriptions.json.migrated`. Copy `subscriptions.json` somewhere safe before upgrading. To roll back to an older
image, copy `subscriptions.json.migrated` back to `subscriptions.json`; the old version reads only that file, so
changes made after the upgrade are lost. A damaged `subscriptions.json` is moved aside as
`subscriptions.json.corrupt-<time>` and the site starts with an empty list instead of failing. Likewise a damaged
`yt.db` is moved aside as `yt.db.corrupt-<time>` (with its `-wal`/`-shm`) and a fresh one is created. The backend opens
the database at start, logs `DATABASE UNAVAILABLE` if it cannot, and `/healthz` (the container health check) answers
503 until it works.

*Backup:* the cache is disposable, so only the subscriptions matter (`sqlite3 yt.db "DELETE FROM cache"` shrinks a
backup, and `yt.db` can even be deleted to drop the cache, though that also drops subscriptions). To back up while
the backend runs, use SQLite's own tools (`sqlite3` is in the dev shell):
`sqlite3 backend/data/yt.db ".backup backup.db"` (or `VACUUM INTO 'backup.db'`). Do not copy `yt.db` alone while it
is running: recent changes may still be in the `-wal` file. With the backend stopped
(`podman-compose stop backend`; a clean stop checkpoints the WAL), copying `yt.db` is enough.
*Restore:* stop the backend, delete `yt.db-wal` and `yt.db-shm`, copy the backup over `yt.db`, start it.
The file is not auto-vacuumed, so it does not shrink when rows are deleted (it is reused instead).

The database files are created owner-only (0600; a data directory the backend creates is 0700). Schema changes are versioned migrations (`backend/src/db.ts`) applied automatically at start. (Node prints a one-line "SQLite is an experimental feature" warning in development; the container start command silences it.)

*Upgrading:* an existing `subscriptions.json` is imported automatically on first start and renamed to
`subscriptions.json.migrated` (keep it as a backup, or delete it). A damaged file is moved aside as
`subscriptions.json.corrupt-<time>` and the site starts with an empty list instead of failing.

*Backup:* stop the backend (`podman-compose stop backend`; a clean stop checkpoints the WAL into `yt.db`) and copy
`yt.db`. For a backup while it runs, copy `yt.db`, `yt.db-wal` and `yt.db-shm` together, or run
`sqlite3 backend/data/yt.db ".backup backup.db"`. Restoring is copying the file back.

**Hardening.** The backend runs as a non-root user with a read-only root filesystem, no Linux capabilities, and
memory/process limits. nginx is the non-root `nginx-unprivileged` image and sets a Content-Security-Policy and
related headers. Both base images are pinned by digest.

**yt-dlp** is pinned and checksum-verified in `backend/Containerfile` (`YTDLP_VERSION`, `YTDLP_SHA256`); the
container never updates it at runtime. A weekly workflow proposes the bump as a pull request (see
[Keeping yt-dlp fresh](#keeping-yt-dlp-fresh)). To do it by hand: `scripts/bump-ytdlp.sh VERSION SUMS BINARY` with the
release's downloaded `SHA2-256SUMS` and `yt-dlp` files (it verifies the checksum and edits both pins), then rebuild.
The backend logs the yt-dlp version at start.

### Status and health

`GET /api/status` (same host allow-list and, if set, access token as the other `/api` routes; no secrets, URLs or paths) returns:

```json
{ "health": "ok",
  "ytdlp": { "version": "2026.10.26", "present": true },
  "resolves": { "ok": 1, "failed": 1, "consecutiveFailures": 0,
                "lastSuccess": { "at": "<ISO time>" },
                "lastFailure": { "at": "<ISO time>", "reason": "bot-check" } },
  "ffmpeg": { "present": true, "version": "8.0.1" }, "node": "v22.22.0", "uptimeSeconds": 61,
  "cache": { "ok": true, "entries": 12, "bytes": 48213 } }
```

`health` is `failing` when the last 3 real yt-dlp resolves failed with no success since, `degraded` when the latest
resolve failed, yt-dlp cannot be run or the database is unusable, otherwise `ok`. Failures caused by the video itself
(`unavailable`: private, removed, age-restricted, members-only) are counted and shown as the last failure, but never
count toward `consecutiveFailures` or `health`. No video ids are returned (so the page stays safe to expose on a LAN). The yt-dlp version is read once from
`yt-dlp --version` and refreshed lazily (hourly). `resolves.ok/failed` count since the process started; the last
success and last failure (with a fixed reason label such as `bot-check`, `rate-limited`, `unavailable`, `timeout`,
`network`) are kept in the SQLite `meta` table and survive restarts. Cache hits are not resolves. The web UI shows
this at `/status` (rendered by the backend as plain text without JavaScript, because the shipped JS is at its size budget; link in the footer of the home page); the Android app has a Status button in Settings.

**Network exposure.** `compose.yaml` publishes port 8080 on all interfaces. To limit it, change the mapping to
`"127.0.0.1:8080:8080"` or your LAN address. Set `ALLOWED_HOSTS` (below) to guard against DNS-rebinding. The app has
no per-user login: either keep it on a network you trust or set the shared `ACCESS_TOKEN` (next section).

**Access token (optional).** Set `ACCESS_TOKEN` in `backend/.env` (16 to 512 printable ASCII characters, no spaces or
commas, for example `openssl rand -hex 24`; the backend refuses to start with a bad one) and every `/api/*` and
`/stream/*` request must carry it, as `Authorization: Bearer <token>` (Android, scripts) or as the `yt_session` cookie
(web). Unset, nothing changes and the backend logs that it is open; an *empty* `ACCESS_TOKEN=` logs a loud warning, and
`REQUIRE_AUTH=1` makes the backend refuse to start unless a valid token is set (use it if you intend to have auth, so a
typo can't silently leave the app open). Static pages and `/healthz` stay public (they hold no data),
`GET /api/session` is open and returns `{"auth":"required"|"none","authenticated":bool}`, and the stream is authorised
before yt-dlp or ffmpeg is started. The web UI redirects to `/login` on a 401. The login page is a plain HTML form (no script needed to submit): the
backend answers a browser form post with a 303 to `?next=` after validating it as a same-site path (control characters,
backslashes, `//` and encoded forms are refused), or back to `/login#bad`; the footer's *Log out* is a form too.
`POST /api/login` (JSON `{token}` or form; scripts get JSON and status codes) compares in constant time (SHA-256 digests + `timingSafeEqual`), sets an
HttpOnly, `SameSite=Strict` cookie (30 days) and `POST /api/logout` clears it. Login and logout keep the same-origin
check; there is no CORS. The cookie is `Secure` when the request arrived over https: the bundled nginx passes an incoming
`X-Forwarded-Proto: https` from your TLS proxy through (a client can only spoof that to add `Secure` to its own cookie).
Android: Settings has an optional *Access token* field (sent only to the configured server; the connection test says
whether a token is needed or rejected).

*Lockout.* Failed attempts (wrong login token or wrong bearer, including on `/api/session`) are limited to 10 per client
per **5 minutes**, then 429 with `Retry-After`. While a client is locked out, even the right token is refused (otherwise
429 versus 200 would let it keep guessing); requests with a valid session cookie are unaffected. Behind the bundled nginx
the client is the `X-Forwarded-For` it sets, so users behind one NAT share a lock, and a looser global cap (200 failures
per 5 minutes) bounds guessing if that header is spoofed (it can only be when the backend is reachable directly: don't
publish its port). The limiter is in memory (a restart resets it) and holds at most 2000 clients. The trade-off is that
anyone who can send wrong tokens can briefly stop *new* logins from their address or, with the global cap, from everyone;
the short window keeps that to minutes.

*Why a signed cookie, not a session table:* the cookie is `<expiry>.<HMAC-SHA256(key, "session:<expiry>")>` and never
contains the token. `key` is derived from the token and a random secret generated once and kept in the database `meta`
table, so a sniffed cookie can't be brute-forced offline against a weak token, sessions survive restarts, and rotating
`ACCESS_TOKEN` signs everyone out. It needs no session table. The price is that one session can't be revoked early:
rotate the token. The token is stored in the Android app's private DataStore (not encrypted at rest, no extra
dependency, excluded from backups) and in the server's environment.

*What it does not do:* there is no TLS, so on plain http the token and cookie travel in the clear and anyone on the
path can read them. It keeps casual users and other devices on the LAN out; it does not make the app safe to expose to
the internet. Use a VPN or a trusted LAN (or put your own TLS proxy in front).

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

To update yt-dlp in the dev shell, run `scripts/bump-ytdlp.sh` (it edits `shell.nix` and `backend/Containerfile` together), or bump `ytDlpVersion` and `sha256` in `shell.nix` by hand (hex or base32 digests both work).

### Watch history and privacy

The history is stored only in your own `yt.db` and is never sent anywhere. It is not tied to an account: anyone who
can reach your server can read it, like the subscriptions. A video is recorded once you have watched 5 seconds, a
position is only saved when it moved by at least 2 seconds, and a video counts as watched (completed) when you reach
within 10 seconds of the end or the player reports it ended. Titles and channels are never taken from the client.
Trust model: like the subscriptions, the history can be read, removed and cleared by anyone who can reach the API
(the LAN trust model; an optional access token is planned separately). A still-open playing tab can write an entry
back after you removed or cleared it; that is accepted. To stop junk from evicting real history, at most 60 *new*
history rows are accepted per hour (further new videos get HTTP 429 until the window passes; existing rows keep
updating), positions and durations are capped at 100 hours, and paging uses an opaque `next` cursor passed back as
`before`. The web page only reports once a video has really started playing.
To remove entries use the Remove buttons on `/history` (or the Android History screen); **Clear all history** (web
and Android) deletes everything, or `curl -X POST http://localhost:8080/api/history/clear`.

API notes: `POST /api/progress` takes `id`, `position` (seconds) and optional `finished` as a form or JSON and, like the
other POSTs, refuses cross-origin requests; `GET /api/video/:id` adds `progress: {position, completed}` when the video
is in the history; `/api/home` adds `continue` (up to 12 unfinished videos, most recent first).

## Android app

`android/` is a native Kotlin + Jetpack Compose app that uses the same backend API as the web frontend: home feed,
search, watch (with the seek bar), channel pages, subscribe/unsubscribe, subscription import/export (Settings), a "Continue watching" row, watched badges and a
History screen (Home, "Watch history"). Playback uses Media3/ExoPlayer.

**Build and install** (the Android SDK is large, so it has its own Nix shell, separate from the root one):

```bash
nix-shell android/shell.nix                       # JDK 17, the SDK (platform 37), adb
cd android && ./gradlew :app:assembleDebug        # -> app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

CI also builds the debug APK on pull requests that touch `android/` and attaches it to the run as an artifact.

**First launch:** open Settings (the gear) and enter the backend's address, for example `192.168.1.153:8080` on home
Wi-Fi, or its VPN host name when you're away, then **Test connection** and **Save**. The app uses plain `http://`
(cleartext is allowed for this reason), so only use networks you trust, even with an access token (it is sent unencrypted
over http). Enter the token under *Access token* if the backend sets `ACCESS_TOKEN`.

**How it works:** the backend's video stream is a live remux that can't be seeked, so the app knows the real duration
from the API and *restarts* the stream at `?t=<seconds>` when you drag the seek bar or change quality (the web
player does the same). Expect a second or two of buffering after a seek.

**Releases:** every merge to `main` that touches `android/` publishes a signed release APK to
[GitHub Releases](../../releases) (`cd.yml`, tag `v<versionName>-<run number>`). Download it on your phone and allow
"Install unknown apps" for your browser. All releases are signed with the same key, so each one installs over the last.
The key comes from the repository secrets `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`
and `ANDROID_KEY_PASSWORD`; keep a backup of the keystore, because losing it means a new install is needed.

**Fullscreen:** the corner-brackets button next to the seek bar plays the video fullscreen and hides the system bars. On
phones it also switches to landscape; Android 16+ ignores orientation requests on large screens (smallest width of
600dp or more) and in multi-window, so there only the bars are hidden. Tap the video to hide the controls, Back to leave.

**Background audio:** playback continues when you press Home or the screen turns off. A media notification (title,
channel, thumbnail, play/pause and a seek bar showing the real position and length) appears, and the lock screen and
headset/Bluetooth buttons control it. Seeking from the notification restarts the stream at that offset, like the seek
bar. Android 13+ asks for notification permission the first time something plays; if you say no, audio still
continues, only the notification is hidden. The player lives in a foreground service (`mediaPlayback`) and ends, with
its notification, when the video finishes, when you stop it (or dismiss the notification), when it fails while the app
is in the background, or when you swipe the app away while paused. Leaving the watch screen with the app open still
stops playback. Settings has **Keep playing in the background** (on by default); turn it off and the app pauses and
removes the notification whenever it goes to the background. Headset and Bluetooth buttons only work while the
service is alive: it is stopped after the video finishes, after you stop it, after an error in the background, and (with
the setting off) whenever the app is in the background, so open the app and press Play again.

**Not yet:** picture-in-picture, offline downloads, Play Store publishing.

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
| `DATA_DIR` | `./data` (`/data` in the container) | Where the SQLite database `yt.db` is stored (must be writable) |
| `ACCESS_TOKEN` | unset (open) | Shared secret (16-512 printable ASCII chars) required on `/api/*` and `/stream/*`; see "Access token" |
| `REQUIRE_AUTH` | unset | `1` = refuse to start unless a valid `ACCESS_TOKEN` is set |
| `ALLOWED_HOSTS` | unset (any; a warning is logged at start) | Comma-separated `Host` header values to accept, e.g. `192.168.1.10:8080`; others get 421. Set it: it blocks DNS-rebinding |
| `MAX_STREAMS` | `3` | Concurrent video streams; extra requests get 503 |
| `STREAM_MAX_SECONDS` | `21600` | Hard cap on one stream's duration |
| `SEARCH_FALLBACK_MAX` | `20` | Daily cap on Data API searches (100 quota units each), including their follow-on pages |
| `TAB_UNITS_MAX` | `500` | Daily Data API units the channel tab routes may use (1-2 units a fetch); more gets 429 |
| `TAB_REQUESTS_PER_HOUR` | `1200` | Channel tab requests per hour, cached or not; more gets 429 |

The numeric settings must be whole numbers; anything else is logged and the default is used.

URL parameters on the watch page: `q` (quality: 360, 480, 720, 1080), `t` (start offset in seconds), `a` (audio
language code such as `pt`). For example `/watch?v=VIDEO_ID&q=1080&t=90`.

## Limitations

- **Seeking** outside the already-buffered part restarts the stream (about 1–2 seconds). There is no seek preview.
- **Related videos** use YouTube's unofficial `/next` endpoint. If it stops working, the watch
  page falls back to "More from this channel" (1 quota unit).
- **Search results** have no upload date, because the free yt-dlp search doesn't return one.
- **Comments, playlists, login, live streams and Shorts-specific pages** are not implemented.
- Everything depends on yt-dlp keeping up with YouTube. If playback stops working, update yt-dlp first.

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Error page: `YouTube API … 403 … IP address restriction` | The key is restricted to other IPs. Add the address named in the error to the key's restrictions, or remove the IP restriction. |
| `YT_API_KEY is not set` | Create `backend/.env` from `backend/.env.example`. |
| `502` from every page right after recreating the backend | nginx re-resolves the backend name every few seconds (`frontend/05-resolver.sh`), so it recovers on its own within about 5 s. If it persists, check `podman-compose logs frontend` for `05-resolver: using …` and `podman-compose logs backend`. |
| Video won't start, or `/stream/…` returns 502 | yt-dlp is out of date or YouTube changed. Merge the weekly yt-dlp bump PR, or bump the pin (`scripts/bump-ytdlp.sh`), and rebuild; `/status` shows the version and the last failure reason (`podman-compose up -d --build`). Check `podman-compose logs backend`; it prints the yt-dlp version at start. A 503 means all `MAX_STREAMS` slots are busy. |
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
- **`cd.yml`** builds a signed release APK and publishes it to GitHub Releases when a change under `android/` is merged to
  `main` (or when run by hand). Third-party actions are pinned to commit SHAs and the signing secrets are only given to the
  build step. There is no server deployment target yet.
- **`ytdlp-bump.yml`**: see below.
- Dependabot proposes weekly updates for the backend and frontend npm packages and for the actions themselves.

### Keeping yt-dlp fresh

`.github/workflows/ytdlp-bump.yml` runs weekly (Mondays) and on demand (Actions tab, "Run workflow"). It:

1. finds the latest yt-dlp release through the GitHub API and **waits until it is at least 48 hours old** (override with
   the `min_age_hours` input when dispatching by hand), a window in which a bad or compromised release is usually pulled;
2. downloads the `yt-dlp` binary and `SHA2-256SUMS` and checks the binary's checksum, and, if the release ships
   `SHA2-256SUMS.sig`, the signature too (below);
3. runs `scripts/smoke-ytdlp.sh`, which resolves a stream URL for the public video `jNQXAC9IVRw` with the new binary;
4. opens or updates a pull request from `bot/yt-dlp-<version>` that edits the pin in `backend/Containerfile` and
   `shell.nix`, and closes an older open bump PR from this repository as superseded.

Only the second job has `contents: write` and `pull-requests: write`. It re-downloads, re-verifies, and refuses unless
the binary is byte-identical (same SHA-256) to the one the first job tested. The first job's checkout keeps no
credentials, because it runs the downloaded binary. The edit itself is `scripts/bump-ytdlp.sh` (idempotent; refuses on a
checksum mismatch, a bad signature, a missing or duplicate checksum entry, a bad version or a changed pin layout),
tested offline by `scripts/test-bump.sh`, which CI runs together with `shellcheck`.

What is verified, precisely: the checksum check is **integrity against the release's own `SHA2-256SUMS`, the same trust
root as the release itself**; someone who can replace the binary on GitHub can replace that file too. Authenticity comes
from the GPG signature: the yt-dlp project publishes its signing key at
<https://github.com/yt-dlp/yt-dlp/blob/master/public.key> (linked from its README, "Release Files"). That file is
committed here as `scripts/yt-dlp-release.pub`; the fingerprint pinned in `scripts/bump-ytdlp.sh`
(`AC0CBBE6848D6A873464AF4E57CF65933B5A7581`, "Simon Sawicki (yt-dlp signing key)") was computed from that copy on
2026-11-02, because the project does not publish the fingerprint anywhere else, and the 2026.10.26 release's signature
was checked against it (that real signature is a test fixture). So the trust is "the key yt-dlp's repo served that day",
visible in this repo's history. If the project rotates its key, verification fails closed and a person has to review and
replace the key and fingerprint. Releases without a signature are still bumped, with the PR saying "not verified".

The smoke test is **advisory**. YouTube often answers GitHub's data-centre IPs with "confirm you're not a bot" (also
rate limits or no network); then the result is `inconclusive`, the PR is still opened and says so, and you should try
the new yt-dlp yourself. If yt-dlp crashes, prints no URL or fails for any other reason, the run fails and no PR is
opened.

Limitations, honestly:

- **CI does not start on the bot's PR.** GitHub does not trigger workflows for pull requests created with the default
  `GITHUB_TOKEN`, so the required checks stay pending and `main`'s protection keeps the PR unmergeable. Close and
  reopen the PR (or push an empty commit to the branch from your account) to start CI. To avoid that, create a
  fine-grained personal access token with contents and pull-requests write on this repo and store it as the secret
  `YTDLP_BUMP_TOKEN`; the workflow then uses it, and CI starts by itself. Either way the PR still needs its required
  checks and your review: nothing is merged automatically and no protection is bypassed.
- **Reviews on bot PRs.** A PR authored with your PAT is *your* PR, and GitHub does not let you approve your own PR. If
  `main` requires reviews, you can only merge it with the admin bypass; the alternative is a token from a separate bot
  account or a GitHub App (store its token as `YTDLP_BUMP_TOKEN`), so a person other than the author can approve.
- The repository setting "Allow GitHub Actions to create and approve pull requests" must be enabled (Settings,
  Actions, General), unless you use the token above.
- The smoke test covers one ordinary public video, not age-restricted, region-blocked or live ones.

Run the same checks locally with `nix-shell --run 'cd backend && npm run check && cd ../frontend && npm run check'`.

`main` is protected: changes go through a pull request, and the CI jobs must pass before merging.

### TV mode

One video plays, and when it ends the next one starts: no prompts, no choices, no recommendations. The rules:

- Videos come from your **subscribed channels only**. Each pick is random: a random channel, then a random video from its
  recent uploads (the cached RSS feed, the last ~15).
- **Never two videos in a row from the same channel.**
- TV needs **at least 5 subscriptions**. Below that the TV entry is greyed ("Subscribe to N more channels to turn on TV")
  and the server answers 409. If you unsubscribe below 5 while TV runs, the current video finishes and TV then stops with a message.
- Skipped: Shorts (under 61 s), live and upcoming streams, videos without a duration, and anything that cannot be looked up.
  Videos already watched to the end (history) are left out too: they are only used again if every channel has been
  examined and none had anything unwatched left. The last ~50 played ids are never repeated.
- **Skip** and **Stop** are the only controls (plus the normal player). After 3 failures in a row TV stops with a message.
- Web: `/tv` (masthead "TV"; greyed, with the reason as visible text, until 5 subscriptions). Only one request runs at a
  time and a late answer after Stop or another Skip is dropped. A TV video is only reported to the history once it has
  played 30 s or ended, so skipped videos leave no history rows and do not use up the 60-new-rows-per-hour cap.
- Android: "TV" on Home, started by a tap (a restored screen never starts it by itself). The next video is requested
  15 s before the end and handed over without a gap, so with the screen off the notification stays (and a short wake
  lock covers a fallback request); fullscreen carries over and has Skip and Stop. TV stops when the app is hidden with
  background playback off, when the task is removed, on a rejected token ("Open Settings"), and after 3 failures in a
  row (a failure streak only ends once a video really played for 5 s). If you drop below 5 subscriptions the current
  video finishes and TV then stops; the reason shows on the TV screen and on Home.

`GET /api/tv/next?after=<channelId>&seen=<id,id,...>&q=<quality>` is stateless: `after` is the channel that just played,
`seen` the recently played ids (at most 100 ids / 1200 characters are read). GET only, and a cross-site request is refused
(403) before any lookup. It is rate limited (burst of 3, then 1 a second, 240 an hour for the whole server; 429 with
`Retry-After`). It returns the `/api/video/:id` shape without `related`, plus `channelId`;
`409 {error, code:"need-subscriptions", have, need:5}` below 5 subscriptions; `404 {code:"nothing-playable"}` when
nothing was found within the budget. The pick walks the channels (not `after`) in random order, a few at a time, until
one has an unseen, unwatched, playable video; one request looks at no more than 40 feeds and 40 videos (5 per channel,
one cached Data API unit each) within 12 s, and stops early if the client disconnects.
`GET /api/tv/status` returns `{have, need, ok}` (the masthead uses it).
Code: `backend/src/tv.ts` (pure picker with an injectable `rand`), `frontend/public/js/tv.js`, Android `player/TvSession.kt`, `ui/Tv.kt`.

## Project layout

```
backend/
  src/server.ts          starts the server, shuts down cleanly
  src/app.ts             routes and request handling
  src/yt/api.ts          YouTube Data API client
  src/yt/dlp.ts          yt-dlp URL resolution + live ffmpeg remux
  src/status.ts          /api/status: resolve counters, persisted last success/failure, health
  src/yt/search.ts       yt-dlp search (Data API fallback)
  src/yt/innertube.ts    related videos from YouTube's /next
  src/yt/rss.ts          channel RSS feeds
  src/db.ts              SQLite connection + migrations (DATA_DIR/yt.db)
  src/history.ts         watch history and resume positions (SQLite)
  src/playlists.ts       Watch later and user playlists (SQLite)
  src/auth.ts            optional shared access token: bearer/cookie checks, constant-time compare, failure limiter
  src/tv.ts              TV mode: the random, never-the-same-channel picker
  src/store.ts           subscriptions (SQLite, imports the old subscriptions.json; atomic bulk addSubs)
  src/subsio.ts          subscription import (Takeout CSV, OPML, URL list) and export parsers/writers
frontend/
  public/*.html          the pages, with <template> blocks (all of the HTML)
  public/classic.css     the classic look; follows the system light/dark setting
  public/js/             vanilla JS: lib (helpers), fmt (formatting), one module per page, player (seek bar)
  test/                  formatter tests and the JS guardrails (size budget, no unsafe sinks, same-origin only)
  nginx.conf             page routes, security headers, reverse proxy for /api and /stream (re-resolves `backend` at runtime)
  05-resolver.sh         at start, turns the container's DNS server into nginx's `resolver` line
scripts/                 bump-ytdlp.sh (verify + pin a yt-dlp release), smoke-ytdlp.sh, test-bump.sh, yt-dlp-release.pub (signing key), testdata/
android/                 the native Android app (Kotlin + Compose); has its own shell.nix and Gradle wrapper
compose.yaml             runs both containers
shell.nix                dev shell
```

## License

[0BSD](LICENSE) (BSD Zero Clause): do whatever you like with this code, with no conditions and no need to keep any
notice. It comes with no warranty. This covers the code in this repository only, not YouTube's content or terms, and
not yt-dlp or ffmpeg, which have their own licenses.
