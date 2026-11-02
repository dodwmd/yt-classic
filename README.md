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
- **Chapters and clickable timestamps.** `GET /api/video/:id` adds `chapters: [{start, end, title}]` (seconds; omitted when there are none),
  parsed server-side from the description, which is already fetched, so it costs no extra API units. The rule is YouTube's: a run of
  lines that each start with a timestamp (`0:00 Intro`, `1:02:03 - Title`, `(2:15) Title`, `[01:02] Title`, optionally after a bullet or
  emoji), starting at `0:00`, strictly ascending, at least 3 entries; a non-timestamp line ends the run, blank lines do not; entries at or
  after the duration are dropped; titles are plain text of at most 100 characters; at most 100 chapters; `end` is the next start (the
  duration for the last). The matching is linear time (bounded prefix, no nested quantifiers). **Linking rule for clients:** in the
  description, any `h:mm:ss` or `m:ss` (`(?<![\w:/.@#?=&%])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?!\w|:\d|[/.]\w)`, seconds < 60, minutes < 60
  when hours are present) that is not part of a URL or longer token and is before the duration becomes a seek link (so `1:30-2:00` links both ends); comments stay plain
  text. The web and Android linkers share one set of cases (`backend/test-fixtures/timestamp-links.json`, run by both test suites); the backend list parser is a stricter variant of the same rule (it also needs a title and the run rules above), and Android uses the server's `chapters` for the list and its own linker only for in-text links. Web: the lazily loaded `chapters.js` (only fetched when the video has chapters or timestamps) makes the links, adds a collapsed
  "Chapters (N)" list with the current chapter highlighted, shows the current chapter's name in the control bar (hidden in landscape
  phones) and binds `[` / `]` to the previous / next chapter; there are no seek-bar ticks on the web. Android: timestamps are underlined links (TalkBack lists them; not styled as links when the video can't be played), a collapsed "Chapters (N)" row expands to tappable rows with the current one marked, the chapter name shows under the
  controls (also fullscreen; not in picture-in-picture, where there are no controls) and ticks are drawn under the seek slider. Taps
  restart the stream at that second, like the seek bar. Web timestamp links are real `/watch?v=ID&t=N` links (new tab and copy-link work; a plain click seeks in place), and chapter seeks are limited to one per 300 ms.
- **Comments** (read-only; web: a collapsed "Show comments (N)" section on the watch page, Android: a "Show comments" row on
  the Watch screen). Nothing is requested, and on the web no comment code is downloaded, until it is opened. Top/Newest,
  "Load more" (20 a page) and per-comment "Show N replies" (loaded on demand). Comments are shown as plain text (the API is asked for
  `textFormat=plainText`, so nothing is stripped or decoded; control and invisible characters such as bidi overrides,
  zero-width spaces and BOMs are removed) and links in the text are not clickable. Avatars are only passed on from
  `yt3.ggpht.com`, `yt3.googleusercontent.com` and `*.ytimg.com`. The web page shows at most 200 comments (or replies) per list. Replying, liking and posting are not
  available. `GET /api/video/:id/comments?order=top|new&pageToken=` and `GET /api/comments/:commentId/replies?pageToken=`
  return `{items: [{id, author, authorChannelId?, authorThumb? (https only), text, likeCount, publishedAt, updatedAt?,
  replyCount}], nextPageToken?}` (text at most 5000 and author at most 100 UTF-16 units; items with malformed ids are dropped;
  the total shown on the button is the video's `commentCount`). Each page costs 1 Data API unit (`commentThreads.list` and
  `comments.list`) and is cached for 10 minutes, first pages also in the database. Comments share a Data API budget
  (`COMMENT_UNITS_MAX`, default 300 units a day) and an hourly request cap (`COMMENT_REQUESTS_PER_HOUR`, default 600),
  separate from the channel tab budget; beyond either they answer 429 `rate-limited` with `Retry-After`. A video with
  comments turned off answers `403` with code `comments-disabled`, remembered for an hour for both orders and every page (also across restarts), so asking again costs no units and no hourly request slot; page tokens
  must match `[A-Za-z0-9_-]{1,120}`, video ids 11 characters, comment ids `[A-Za-z0-9_-]{16,80}`.
- **Subtitles and captions** (both clients; off by default). A **CC** button sits in the player controls. The track list costs the server a
  yt-dlp run, so it is only asked for when captions are first turned on (or were left on), or, on Android, when the CC menu is first
  opened; a video without tracks says "No subtitles for this video". A language menu (web: a select next to the button, Android: the
  menu on the button) and the on/off state are remembered (web: localStorage, Android: DataStore). Android starts on the saved language,
  else the device language (the same primary subtag matches, so `en` finds `en-GB` or `en-orig`), else the first manual track. Web: `c`
  toggles. The stream is a remux restarted at `?t=` on every seek, so the clients do not use `<track>` or ExoPlayer's text renderer:
  they parse the WebVTT themselves (web: lazily loaded `subs.js`; Android: `data/Subtitles.kt`) and show the cue for the absolute time
  (stream offset + player time) as plain text over the video, in fullscreen too (not in Android picture-in-picture). Automatic captions
  drop the lines their rolling cues repeat. On Android rows narrower than 420 dp (more at larger font sizes) the seek bar gets its own
  row and speed, CC, picture-in-picture and TV Skip/Stop move into a "More controls" menu.
  `GET /api/video/:id/subs[?pref=<lang>]` lists `{tracks: [{lang, name, auto}]}`: manual tracks first, then automatic ones (`pref`
  first, then originals such as `en-orig`, then languages that also have a manual track, then the rest sorted), one track per language,
  at most 30 (`pref`, when the video has it, is never cut); language codes must match `^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$`, so
  keys such as `live_chat` or `a.en` are skipped. `GET /api/video/:id/subs/:lang.vtt` returns `text/vtt`. Both come from one yt-dlp
  metadata call per video (its own single slot, separate from playback and search; a hung run is killed after 30 s and a failure is
  remembered for 30 s so reloads cannot re-run it), cached for an hour (no tracks: 10 minutes; only the track list is kept in the
  database, never the VTT or the subtitle URLs). The VTT is fetched from the URL yt-dlp gave, only over https from `youtube.com` /
  `googlevideo.com`, without redirects, with a 10 s timeout (body included) and a 2 MB cap; a 403/410 refreshes the URLs once; bodies
  are kept in memory (8 MB in total) and concurrent requests share one download. A language the video lacks, an oversized download
  or a body that is not WebVTT answers `404` `no-subtitles`.
- **Comments** (read-only; web: a collapsed "Show comments (N)" section on the watch page, Android: a "Show comments" row on
  the Watch screen). Nothing is requested, and on the web no comment code is downloaded, until it is opened. Top/Newest,
  "Load more" (20 a page) and per-comment "Show N replies" (loaded on demand). Comments are shown as plain text (the API is asked for
  `textFormat=plainText`, so nothing is stripped or decoded; control and invisible characters such as bidi overrides,
  zero-width spaces and BOMs are removed) and links in the text are not clickable. Avatars are only passed on from
  `yt3.ggpht.com`, `yt3.googleusercontent.com` and `*.ytimg.com`. The web page shows at most 200 comments (or replies) per list. Replying, liking and posting are not
  available. `GET /api/video/:id/comments?order=top|new&pageToken=` and `GET /api/comments/:commentId/replies?pageToken=`
  return `{items: [{id, author, authorChannelId?, authorThumb? (https only), text, likeCount, publishedAt, updatedAt?,
  replyCount}], nextPageToken?}` (text at most 5000 and author at most 100 UTF-16 units; items with malformed ids are dropped;
  the total shown on the button is the video's `commentCount`). Each page costs 1 Data API unit (`commentThreads.list` and
  `comments.list`) and is cached for 10 minutes, first pages also in the database. Comments share a Data API budget
  (`COMMENT_UNITS_MAX`, default 300 units a day) and an hourly request cap (`COMMENT_REQUESTS_PER_HOUR`, default 600),
  separate from the channel tab budget; beyond either they answer 429 `rate-limited` with `Retry-After`. A video with
  comments turned off answers `403` with code `comments-disabled`, remembered for an hour for both orders and every page (also across restarts), so asking again costs no units and no hourly request slot; page tokens
  must match `[A-Za-z0-9_-]{1,120}`, video ids 11 characters, comment ids `[A-Za-z0-9_-]{16,80}`.
- **Subtitles and captions** (both clients; off by default). A **CC** button in the player controls appears only when the video has
  tracks; a language menu (web: a select next to the button, Android: a menu on the button) and the on/off state are remembered
  (web: localStorage, Android: DataStore). Web: `c` toggles. The stream is a remux restarted at `?t=` on every seek, so the clients
  do not use `<track>` or ExoPlayer's text renderer: they parse the WebVTT themselves (web: lazily loaded `subs.js`; Android:
  `data/Subtitles.kt`) and show the cue for the absolute time (stream offset + player time) as plain text over the video, in
  fullscreen too (not in Android picture-in-picture). Automatic captions drop the lines their rolling cues repeat.
  `GET /api/video/:id/subs` lists `{tracks: [{lang, name, auto}]}` (manual tracks first, then automatic ones, at most 30, one per
  language; language codes must match `^[A-Za-z]{2,3}([-_][A-Za-z0-9]{2,8})*$`) and `GET /api/video/:id/subs/:lang.vtt` returns
  `text/vtt`. Both come from one yt-dlp metadata call per video (its own single slot, separate from playback and search), cached
  for an hour (no tracks: 10 minutes; only the track list is kept in the database, never the VTT or the subtitle URLs). The VTT
  is fetched from the URL yt-dlp gave, only over https from `youtube.com` / `googlevideo.com`, without redirects, with a
  10 s timeout and a 2 MB cap; anything that is not WebVTT is refused. A language the video lacks answers `404` `no-subtitles`.
- **Scrub previews.** Every seek outside the buffer restarts the stream, so both clients show YouTube's storyboard thumbnails while you
  point at or drag the seek bar. `GET /api/video/:id/storyboard` answers `{tiles: {w, h, cols, rows, count, interval, sheets}, duration}`
  (tile size in px, tiles per sheet, tiles in all, seconds per tile, number of sheets) and `GET /api/video/:id/storyboard/:n.jpg` is sheet
  `n` (`0 <= n < sheets`, otherwise `404`). Both come from one yt-dlp metadata call per video (its own single slot, separate from playback,
  search and subtitles; a hung run is killed after 30 s, a failure is remembered for 30 s). The level is the widest tile up to 320 px
  (at least 100 px) that needs at most 40 sheets, so a long video gets a narrower level rather than hundreds of sheets; only levels whose
  sheets are full grids are used (clients map time to a tile by arithmetic). The descriptor is cached for an hour (none: 10 minutes) and only
  it is persisted; the upstream URLs stay in memory, are never sent to a client or logged, and a sheet can only be asked for through the
  video id and the index. A sheet is fetched over https from `ytimg.com`, `googlevideo.com` or `ggpht.com` (the exact name or a subdomain, no
  port, no credentials), without redirects, with a 10 s timeout, a 1.5 MB cap enforced while reading, and only if it is a JPEG, WebP or PNG;
  an expired URL (403/410) is refreshed once. Sheets are kept in a 16 MB in-memory LRU and concurrent requests for a sheet share one download.
  A video without a storyboard answers `404` `no-storyboard`. Web: `previews.js` is loaded lazily on the first pointer over the seek bar
  (mouse hover, pen or touch drag) and shows a tile with the time (and the chapter name, when the video has chapters) above the pointer; it
  is `aria-hidden` and leaves the slider's keyboard use alone. Android: while you drag the seek bar a bubble above the thumb shows the tile
  cropped from the decoded sheet (fetched with the access token, at most 8 MB of decoded sheets kept) with the time and chapter title, inline and in
  fullscreen, and never in picture-in-picture; TalkBack hears the slider's own time announcement, not the bubble.
- **Subscriptions home page**: merged feed of your subscribed channels (from their RSS feeds, no API quota), with
  view counts, "Load more" paging and filters (channel, hide watched, hide Shorts, hide live); see [Feed controls](#feed-controls).
- **Import and export subscriptions**: bring your YouTube subscriptions over in one step (page `/subscriptions`, or
  Settings in the Android app); see [Importing and exporting subscriptions](#importing-and-exporting-subscriptions).
- **Search**: classic results list, paged, using yt-dlp (no API quota). A **Videos | Channels** toggle, a length filter
  (under 4 min, 4 to 20 min, over 20 min) and a sort (relevance, upload date, view count) on the web results page (plain
  GET form controls, so a results URL can be shared) and as chips in the Android app. Channel results have a
  Subscribe/Unsubscribe button and are marked when you already follow them. The search box suggests as you type and
  offers your recent searches when it is empty; see [Search, suggestions and recent searches](#search-suggestions-and-recent-searches).
- **Watch page**: playback in a plain `<video>` tag, a related-videos list, a quality menu (360p up to 4K where the video has it, plus "Auto (max for screen)"; changing it restarts the stream in place at the current position, with no page load, and is remembered in the browser) and a seek bar, a playback speed selector (0.5x to 2x, remembered in the browser; `<` and `>` change it) and double-click/double-tap on the left or right third of the video to seek 10 s (repeated taps add up; the single tap still plays/pauses). The speed code is the lazily loaded `speed.js`.
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
  `DELETE /api/history/:id`, `POST /api/history/clear`, `GET /api/search?q=&type=video|channel&duration=any|short|medium|long&sort=relevance|date|views&pageToken=`, `GET /api/search/suggest?q=`, `GET /api/searches`, `DELETE /api/searches`, `DELETE /api/searches/:id`, `GET /api/tv/next`, `GET /api/tv/status`, `GET /api/feed`, `GET/POST /api/prefs`, `GET /api/playlists`, `POST /api/playlists` (`name`), `POST /api/playlists/:id/rename`, `DELETE /api/playlists/:id`, `GET /api/playlists/:id?limit=&before=<cursor>`, `POST /api/playlists/:id/items` (`id`), `DELETE /api/playlists/:id/items/:videoId`, `POST /api/playlists/:id/move` (`id`, `index`), `GET /api/playlists/membership?ids=a,b` (max 100), `/api/subscriptions/import` and `/export`) plus the video stream (`/stream/:id`). It contains no HTML.
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
  "cache": { "ok": true, "entries": 12, "bytes": 48213, "hits": 30, "misses": 12, "dbBytes": 212992 },
  "streams": { "active": 0, "started": 2, "finished": 2, "failed": 1 },
  "dataApi": { "unitsToday": 12, "searchFallbackRemaining": 20 } }
```

`health` is `failing` when the last 3 real yt-dlp resolves failed with no success since, `degraded` when the latest
resolve failed, yt-dlp cannot be run or the database is unusable, otherwise `ok`. Failures caused by the video itself
(`unavailable`: private, removed, age-restricted, members-only) are counted and shown as the last failure, but never
count toward `consecutiveFailures` or `health`. No video ids are returned (so the page stays safe to expose on a LAN). The yt-dlp version is read once from
`yt-dlp --version` and refreshed lazily (hourly). `resolves.ok/failed` count since the process started; the last
success and last failure (with a fixed reason label such as `bot-check`, `rate-limited`, `unavailable`, `timeout`,
`network`) are kept in the SQLite `meta` table and survive restarts. Cache hits are not resolves. The web UI shows
this at `/status` (rendered by the backend as plain text without JavaScript, because the shipped JS is at its size budget; link in the footer of the home page); the Android app has a Status button in Settings.

### Error codes

Failures are classified into a closed set (one classifier, `src/errors.ts`, fed by yt-dlp's stderr, the Data API's error
reasons and HTTP statuses). Error responses are `{"error": "<message>", "code": "<code>", "retryable": bool}`; `error` is
the same user-safe text for every cause (never a URL, path, stderr or token), and clients that predate `code` keep working.
Streams answer with this JSON when they fail before the first byte; a mid-stream failure just ends the stream.

| code | HTTP | retryable | meaning |
| --- | --- | --- | --- |
| `age-restricted` | 403 | no | needs a signed-in adult account |
| `region-blocked` | 403 | no | not available in the server's country |
| `members-only` | 403 | no | channel members only |
| `private` | 404 | no | private video |
| `removed` | 404 | no | deleted, terminated or otherwise unavailable |
| `live` | 409 | no | live stream (not playable here) |
| `upcoming` | 409 | no | live event or premiere not started |
| `stale-page` | 400 | yes | the Data API rejected a page token (`invalidPageToken`): start the list again |
| `no-subtitles` | 404 | no | the video has no subtitles in that language (subtitle routes only) |
| `no-storyboard` | 404 | no | the video has no scrub previews, or the sheet number is out of range (storyboard routes only) |
| `comments-disabled` | 403 | no | the video's comments are turned off (comment routes only; the video still plays, so it is not skippable) |
| `bot-check` | 502 | yes | YouTube asks the server to prove it is not a bot |
| `rate-limited` | 429 | yes | HTTP 429 or Data API quota (`quotaExceeded`, `rateLimitExceeded`, ...); `Retry-After: 60` |
| `network` | 502 | yes | timeouts, DNS, connection resets |
| `busy` | 503 | yes | all `MAX_STREAMS` slots in use; `Retry-After: 5` |
| `unknown` | 502 | yes | anything else (see the backend log) |

**For older clients.** Failures that used to be a blanket 502 (and a plain-text body from the stream route) now use the
statuses above with a JSON body: 404 for removed/private videos (including `/api/video/:id` for an unknown id), 403 for
age/region/members, 409 for live/upcoming, 429 for rate limits and quota. Clients must key on the JSON, not on 502. The
access-token lockout (`429 {"error":"too many attempts"}` with `Retry-After`) is a different 429: it has no `code`. A
failed resolve is remembered for 30 seconds per video, quality and audio language, so the page load, the stream and
the web player's error probe (`/stream/:id?probe=1`, JSON only, never starts ffmpeg or takes a stream slot) cost one
yt-dlp run between them.

The first seven are *skippable* (retrying will not help): both clients show no Retry button for them, and TV mode will
use `isSkippable(code)` (Android `data/Errors.kt`) to move to the next video. `GET /api/video/:id` adds
`"playable": false, "reason": "<code>", "message": "..."` when the Data API metadata (live, upcoming, age rating,
private) or a recent yt-dlp failure already says the video cannot be played; the web watch page then shows the reason
instead of a dead player, and a player error on the web page fetches the stream's JSON error to show the real cause.

Two quotas, one story: `src/quota.ts` only *counts* Data API units actually spent today (every request, persisted, shown in
metrics and `/api/status`), while `src/tabquota.ts` and `src/commentquota.ts` are the *budgets* for the channel tab routes
(`TAB_UNITS_MAX`, `TAB_REQUESTS_PER_HOUR`) and the comment routes (`COMMENT_UNITS_MAX`, `COMMENT_REQUESTS_PER_HOUR`). When a budget is used up its routes answer a classified `rate-limited` 429 with the
budget's own message and a `Retry-After` until the reset, exactly like a Data API `quotaExceeded`.

### Metrics

`GET /api/metrics` returns Prometheus text format (counters reset on restart; labels come from closed lists, so the
number of series is fixed no matter what is requested): `ytclassic_streams_active`, `_streams_started_total`,
`_streams_finished_total`, `_streams_failed_total`, `ytclassic_resolve_seconds` (histogram of yt-dlp resolves, cache hits
excluded), `ytclassic_http_requests_total{route,status}` (route class and status class), `ytclassic_errors_total{code}`,
`ytclassic_cache_hits_total`, `_cache_misses_total`, `_cache_entries`, `ytclassic_dataapi_units_today` (estimated, UTC
day), `ytclassic_search_fallback_remaining` (daily `SEARCH_FALLBACK_MAX` cap), `ytclassic_sqlite_bytes`,
`ytclassic_uptime_seconds`. `ytclassic_sqlite_bytes` has no sample while the database is unreachable (`dbBytes` is `null` in `/api/status`). The Data API day counters are kept in the SQLite `meta` table, so a restart does not reset the search-fallback cap. The resolve histogram includes failed resolves. Cache hit ratio is `hits / (hits + misses)`; hits include lookups that joined an in-flight fetch or were restored from disk, and all counters reset on restart, so use `rate()` over a window rather than the raw ratio. It is inside the access-token gate like every `/api` route, so with `ACCESS_TOKEN` set the
scraper must send the token:

```yaml
# prometheus.yml
scrape_configs:
  - job_name: ytclassic
    metrics_path: /api/metrics
    authorization: { type: Bearer, credentials: "<ACCESS_TOKEN>" }   # omit when ACCESS_TOKEN is unset
    static_configs: [{ targets: ["192.168.1.153:8080"] }]            # also add this host to ALLOWED_HOSTS if set
```

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

### Feed controls

The home feed is the merge of your channels' RSS feeds (15-minute cache per channel), newest first, held in memory up
to **400 items**; the first screen shows 60 and "Load more" pages through the rest. The feed is as deep as the RSS
feeds are (about 15 videos per channel), so 400 is reached with roughly 27 or more subscriptions.

- `GET /api/home` keeps `subs`, `feed` (the first 60) and `continue`, and adds `next` (cursor, absent at the end) and
  `prefs`. It accepts the same filters as `/api/feed`.
- `GET /api/feed?limit=&before=<cursor>&channel=<UC id>&hideWatched=0|1&shorts=show|hide&live=show|hide` returns
  `{items, next}`; `limit` is 1 to 100 (default 60). The cursor is opaque (the publish time and id of the last item); items are
  ordered by time and then id, so equal timestamps never skip or repeat an item, and a cursor stays valid when the
  feed refreshes. A filter that hides items makes a page look further ahead until `limit` items are found (and one
  item beyond, so `next` is only present when something visible is really behind the page); a page can only come
  back short at the very end. An unknown or malformed parameter is a 400.
- A filter left out of the query falls back to the saved preference (below); nothing is hidden until you choose to.
  This includes `GET /api/home`: it follows the saved preferences, so an older client that knows nothing about
  filters gets a feed already filtered by whatever was saved from the web or Android UI.
  Both clients always send the filters they show, so the screen and the server cannot disagree.
- `GET /api/prefs` and `POST /api/prefs` (same-origin, form or JSON; values are strings, and JSON booleans are accepted:
  for `hideWatched` true means on, for `shorts` and `live` true means `hide`) keep `hideWatched` (`0`/`1`),
  `shorts` and `live` (`show`/`hide`) in the SQLite `meta` table (`feed.hideWatched`, `feed.shorts`, `feed.live`) so the
  web UI and the Android app share them. Only these keys are accepted, partial updates are fine, any bad key or value
  is a 400 (the message names the accepted values) and changes nothing. The channel filter is per visit and not saved.
  The preferences are one set for the whole server, not per device or person: everyone who can reach the server
  shares them (and can change them) unless you set `ACCESS_TOKEN`.
- **Shorts and live.** RSS carries neither duration nor live state, so a Shorts/live filter looks them up with the Data
  API `videos.list` (**1 quota unit per 50 videos**, only for videos not seen before). Results are cached per video id in
  SQLite for a week (10 minutes for live and upcoming videos, whose state changes), so a cold 400-item feed costs at most 8
  units once and normally 0. Deleted/private videos and ones without a duration are looked up again after 30 minutes.
  After a failed lookup no call is made for a minute (so an outage costs one call, not one per request), and at most 60
  such calls are made an hour; past that, filters simply do not apply to videos not yet looked up. A Short is
  a video of 60 seconds or less, or one the feed links as `/shorts/`: this is a heuristic, since YouTube now allows
  longer Shorts and some short videos are not Shorts. "Live" covers live now **and scheduled (upcoming)** streams; they
  report a duration of 0 and are never counted as Shorts. Videos the API does not return (deleted,
  private) and any failed lookup are shown rather than hidden. With neither filter on, no lookups are made. Items that
  were looked up carry `durationSeconds` and `live`.
- **Hide watched** hides videos you watched to the end (a single SQL query per 50 candidates).
- Android: the "Subscriptions" chips filter the feed (tap a channel to show only it, tap again to clear; "Open
  <channel>" next to the chips opens its page); "Hide watched", "Hide Shorts" and "Hide live" are chips under
  "New from your subscriptions"; "Load more" ends the list. Changing a toggle is saved through `/api/prefs`.

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

**Speed and gestures:** the `1x` button next to the seek bar (also in fullscreen) opens a menu of 0.5x to 2x (pitch corrected); the choice is one global default kept in DataStore, also for TV. Double-tap the left or right third of the video to seek 10 s; further double taps within 0.7 s add up and the stream restarts once. TalkBack has "Rewind/Forward 10 seconds" actions on the video. Positions stay in media time at any speed.

**Updates (the one place the app contacts GitHub):** Settings > Updates > *Check for updates* does one unauthenticated
`GET https://api.github.com/repos/dodwmd/yt-classic/releases/latest`. GitHub sees your IP address and the request's
`User-Agent: yt-classic-android`; nothing else identifying is sent. The request uses its own HTTP client (8 s timeout, no
interceptors, authenticator or cookie jar, and redirects are not followed, so a redirect to http is an error rather than
a downgrade), and the server's access token never goes to it. `UpdateTest` proves this: it asserts the client has none of
those and that a request made with it carries no `Authorization` or `Cookie` header. It compares the release tag
(`v0.1.0-N`) with the installed `versionName` + CI run number (`versionCode`; a tag without a run number counts as build 0;
a pre-release tag such as `-rc1` is ignored), and shows "You're up to date" or "Version X is available" with the first 500
characters of the release notes as plain text (control and bidi characters removed) and an *Open release page* button. The
page URL is built only from the fixed repo path and the release's tag string once it has matched `vN.N.N-N`, never from a
URL in the response. Rate limiting (403/429), other errors, malformed answers and being offline give a message instead of an
error. Nothing is checked in the background unless you switch on *Check weekly when the app starts* (off by default): then
at most one check every 7 days, and a note with View/Dismiss appears on Home when a newer version exists. The app does not
install anything itself.

**Layouts:** on windows at least 600dp wide, or in landscape at least 480dp wide (narrower split-screen windows and picture-in-picture keep one column), the watch screen has two panes: the player (with its own scroll
when the window is short) on the left, details and related videos on the right. Portrait phones keep the single column;
fullscreen is unchanged. Likes are shown next to the views (hidden when YouTube hides the count; the web watch page too).

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

**Picture in picture:** a video that is playing shrinks into a small floating window when you press Home or switch apps
(Android 12+ enters automatically; before that the app enters when you leave). The button next to Fullscreen (inline and
fullscreen) does it on demand. The window shows only the video, shaped like it (default 16:9, clamped to the platform's
1:2.39 to 2.39:1), with Play/Pause and, in TV mode, Skip buttons. Tap the window to expand: the same video continues at
the same position, and fullscreen (and its landscape lock) is restored if it was on. Settings has **Picture in picture**
(on by default; the switch is disabled with an explanation when the device lacks it or it is off for the app in system
settings). **Upgrading:** it is on by default, so after updating, pressing Home during a playing video shrinks it into the
window instead of just continuing as audio; turn **Picture in picture** off in Settings for the old behaviour. It only
applies to a video that is actually playing (not paused, buffering a paused seek, finished or failed); otherwise leaving
the app is an ordinary background. How it combines with the other settings: while the window is up the app counts as on
screen, so nothing pauses and **Keep playing in the background** does not matter. Closing the window with X ends the
video like any "stop": it pauses, the notification and (in TV mode) the TV session go away, and reopening the app offers
Play where it left off, whatever the background setting says. A screen that turns off while the window is up is not a
close: playback continues per the background setting. With picture in picture off, or unavailable
(`FEATURE_PICTURE_IN_PICTURE`, or the system's per-app switch), leaving the app behaves as described under Background audio.

**Not yet:** offline downloads, Play Store publishing.

**Testing it without a phone:** the shell can add an emulator (needs KVM, about 2 GB more):

```bash
nix-shell android/shell.nix --arg withEmulator true
# create an AVD once: avdmanager create avd -n yt -k 'system-images;android-36;google_apis;x86_64' -d pixel_6
emulator -avd yt -no-window -gpu swiftshader_indirect &     # drop -no-window to see it
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n io.github.dodwmd.ytclassic/.MainActivity --es server 10.0.2.2:8080   # debug builds only
```

`10.0.2.2` is the host machine as seen from the emulator. `./gradlew :app:testDebugUnitTest :app:lintDebug` runs
the unit tests (API parsing against real captured responses, formatters, seek logic, the update check, layout rules) and
Android lint. There are no instrumented (Compose UI) tests: CI has no emulator, so they could not run there; the UI logic
that can fail (layout choice, version comparison, formatting) is kept in pure functions covered by the JVM tests, and
screens are checked by hand on an emulator.

**Note on the SDK:** the newest Android libraries need `compileSdk` 37, which this nixpkgs snapshot doesn't ship yet,
so `android/shell.nix` adds platform 37 from Google as a hash-pinned download. Once nixpkgs has it, that block can go.


**Quality (1440p, 4K, Auto).** `GET /api/video/:id?q=<360|480|720|1080|1440|2160|auto>&maxh=<px>&codecs=<avc1,vp9,av1>`, and `q`
and `codecs` on `/stream/:id`. Up to 1080p the stream is H.264 + AAC when the video has it. Above 1080p YouTube only has VP9
and AV1, so those are fetched (SDR 8-bit only: HDR and 10-bit streams are skipped; VP9 before AV1; AAC audio when present,
else Opus) and remuxed with `ffmpeg -c copy` into fragmented MP4, no transcoding. VP9, AV1 and Opus in MP4 are verified by
real-ffmpeg tests (run in CI), and VP9 + Opus was also checked with the container's Debian bookworm ffmpeg 5.1. `codecs` is
what the client can decode (default: all); with neither VP9 nor AV1 nothing above 1080p is requested. A tier is the short
side of the picture, so vertical clips are tiered by their width. `q=auto` picks the tallest tier that fits `maxh` (the
display's shorter side in pixels; default 1080), capped at 1080p unless `codecs` has VP9 or AV1. `/api/video/:id` answers at
once with `quality`, `auto`, the usual `qualities` (360 to 1080) and `tiersKnown`; when the video's formats are already
cached it carries the real tiers and `codecs` (per tier: `avc1`, `vp9`, `av1`) too. Otherwise
`GET /api/video/:id/qualities?q=&a=&codecs=` returns `{qualities, codecs, tiersKnown}`, waiting up to 4 s for the same yt-dlp
run that prewarms the stream (so no extra lookup), so clients hide tiers the video lacks or they cannot decode.
The web remembers the choice in `localStorage`, Android in DataStore (after the first frame at that tier; a tier the device
cannot decode steps down one tier by itself). **Auto means "the tallest tier the screen and decoders can use"**, not a
bandwidth-adaptive stream: there is no network measurement. A 4K stream is a lot of bandwidth (often 15 to 40 Mbit/s); the
backend only copies it, so CPU stays low, but each 4K stream needs that much in both directions, and `MAX_STREAMS` of them
add up: lower `MAX_QUALITY` (default 2160) to cap it. Android offers 1440p/2160p only if a hardware, non-secure VP9/AV1
decoder reports the size; its buffer is capped at 48 MB; the chip row scrolls sideways.

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
| `MAX_QUALITY` | `2160` | Highest quality the server will fetch (360, 480, 720, 1080, 1440 or 2160); lower it to limit bandwidth |
| `STREAM_MAX_SECONDS` | `21600` | Hard cap on one stream's duration |
| `SEARCH_FALLBACK_MAX` | `20` | Daily cap on Data API searches (100 quota units each), including their follow-on pages |
| `TAB_UNITS_MAX` | `500` | Daily Data API units the channel tab routes may use (1-2 units a fetch); more gets 429 |
| `TAB_REQUESTS_PER_HOUR` | `1200` | Channel tab requests per hour, cached or not; more gets 429 |
| `COMMENT_UNITS_MAX` | `300` | Daily Data API units the comment routes may use (1 per page fetched); more gets 429 |
| `COMMENT_REQUESTS_PER_HOUR` | `600` | Comment requests per hour, cached or not; more gets 429 |

The numeric settings must be whole numbers; anything else is logged and the default is used.

URL parameters on the watch page: `q` (quality: 360, 480, 720, 1080, 1440, 2160 or `auto`), `t` (start offset in seconds), `a` (audio
language code such as `pt`). For example `/watch?v=VIDEO_ID&q=1080&t=90`.

### Search, suggestions and recent searches

`GET /api/search` keeps its old parameters and response (`items`, `nextPageToken`, `prevPageToken`) and adds
`type=video|channel` (default `video`), `duration=any|short|medium|long` (short is under 4 minutes, medium 4 to 20,
long over 20), `sort=relevance|date|views` and a `notes` array in which the server says when a filter could only be
approximated. Channel searches return `{channels: [{id, title, thumb, description, subscribers?, handle?, subscribed}], nextPageToken}`;
ids are validated, thumbnails are https only.

How it is done (all through yt-dlp first, so no quota): filters use YouTube's own results page
(`https://www.youtube.com/results?search_query=<q>&sp=<filter>`) with `--flat-playlist`, so duration and sort are applied
by YouTube itself, including date sort. Channel search uses the same page with the channel filter
(`sp=EgIQAg%3D%3D`): it returns about 20 channels in two seconds with follower counts and `@handles`, which the Data
API's `search.list` (100 units, and no subscriber count without a second call) does not. If the filtered page fails,
plain `ytsearch` results are filtered by duration locally and `notes` says that sorting by date is not possible (views
are ordered within the page only; such an approximated page is kept for a minute, not ten). Only when yt-dlp is down
altogether does the Data API take over (`videoDuration`/`order`/`type=channel`), behind the same `SEARCH_FALLBACK_MAX`
daily cap, with its own cache keys. The cap counts real API calls only (cache hits and failed calls do not spend), and
the day and count are kept in the database (`meta` table), so a restart does not reset it.

Search has **its own yt-dlp slots** (2 at a time, a queue of 4, a 20 second timeout), separate from the ones playback
uses, so a flood of searches cannot starve playback. When they are all busy the request fails fast with HTTP 503 and
`Retry-After`: a busy server is not treated as "yt-dlp is down" and never spends API quota. Searching and suggesting
refuse cross-site requests (a page on another site cannot make your server search, record or spend quota), and nginx
rate-limits `/api/search` and `/api/search/suggest` per client on top of the backend's own limits.

`GET /api/search/suggest?q=` returns up to 8 suggestions: **this contacts Google** (`suggestqueries-clients6.youtube.com`),
from your server, not from your browser or phone. The query is capped at 100 characters, there is a 2 second timeout
and at most 64 KB of the answer is read, answers are kept in memory for 5 minutes (a failure for 30 seconds), at most
30 requests a minute per client (HTTP 429 beyond that) and 120 in total go out, and any failure gives an empty list.
Search queries are never logged: a failing yt-dlp is logged as its kind, exit code and first stderr line with URLs and
the query removed, never its command line. Searching itself also contacts YouTube, as before. Both web and Android
fetch suggestions only once the search box is used (the web script is loaded on first focus).

Recent searches are stored **on the server**, in `yt.db` (table `searches`: the text and a timestamp), so the web and
Android clients share them. A repeat (ignoring case and spacing) moves to the top, the newest 50 are kept, and only the
first page of a successful search with at least one result is recorded (video or channel; not paging, not suggestions; a database problem never fails the search). `GET /api/searches` lists them,
`DELETE /api/searches/:id` removes one and `DELETE /api/searches` clears all (writes refuse cross-origin requests).
Same trust model as the watch history: anyone who can reach the API (or holds the access token) can read and clear them.
The web results page has a "Clear recent searches" button; the Android search panel has "Clear all" and a remove button
per entry.

## Limitations

- **Seeking** outside the already-buffered part restarts the stream (about 1–2 seconds). There is no seek preview.
- **Related videos** use YouTube's unofficial `/next` endpoint. If it stops working, the watch
  page falls back to "More from this channel" (1 quota unit).
- **Search results** have no upload date, because the free yt-dlp search doesn't return one (date *sort* still works: YouTube does the ordering).
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
  src/errors.ts          the one failure classifier: codes, messages, HTTP statuses
  src/metrics.ts         in-memory counters and the Prometheus text for /api/metrics (scrape.ts gathers the gauges)
  src/quota.ts           Data API units used today and the daily search-fallback cap
  src/status.ts          /api/status: resolve counters, persisted last success/failure, health
  src/yt/search.ts       yt-dlp video and channel search with filters (Data API fallback)
  src/searches.ts        recent searches (SQLite)
  src/suggest.ts         search suggestions (YouTube's public suggest endpoint, cached, never logged)
  src/yt/innertube.ts    related videos from YouTube's /next
  src/yt/rss.ts          channel RSS feeds, merge
  src/feed.ts            feed paging, cursors and filters (Shorts, live, watched)
  src/prefs.ts           saved feed preferences (meta table)
  src/db.ts              SQLite connection + migrations (DATA_DIR/yt.db)
  src/history.ts         watch history and resume positions (SQLite)
  src/playlists.ts       Watch later and user playlists (SQLite)
  src/auth.ts            optional shared access token: bearer/cookie checks, constant-time compare, failure limiter
  src/tv.ts              TV mode: the random, never-the-same-channel picker
  src/store.ts           subscriptions (SQLite, imports the old subscriptions.json; atomic bulk addSubs)
  src/yt/storyboard.ts   scrub-preview storyboards: descriptor from yt-dlp, host-allowlisted capped sheet proxy, LRU
  src/subsio.ts          subscription import (Takeout CSV, OPML, URL list) and export parsers/writers
frontend/
  public/*.html          the pages, with <template> blocks (all of the HTML)
  public/classic.css     the classic look; follows the system light/dark setting
  public/js/             vanilla JS: lib (helpers), fmt (formatting), one module per page, player (seek bar), speed (lazy: speed and double-tap seek), chapters (lazy: timestamp links and chapter list), previews (lazy: scrub previews)
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
