#!/bin/sh
# Smoke test: can this yt-dlp binary resolve a stream URL for a stable public video? Retries transient failures.
#
#   smoke-ytdlp.sh BINARY [VIDEO_ID]      (env: SMOKE_ATTEMPTS=3, SMOKE_DELAY=20 seconds between attempts)
#
# Exit status:
#   0  resolved an https URL (the URL itself is never printed)
#   3  inconclusive: every attempt failed for a reason about the environment, not about yt-dlp (YouTube's "confirm you're
#      not a bot" check or a rate limit against a data-centre IP, or no network). Advisory, not a regression.
#   1  a real problem: yt-dlp crashed, printed no URL, or failed for any other reason.
# The patterns below mirror classifyFailure() in backend/src/status.ts; keep them in step.
set -eu

if ! { [ "$#" -ge 1 ] && [ "$#" -le 2 ]; }; then
  echo "usage: smoke-ytdlp.sh BINARY [VIDEO_ID]" >&2
  exit 2
fi
bin=$1
id=${2:-jNQXAC9IVRw} # "Me at the zoo": the first YouTube video, not going anywhere
attempts=${SMOKE_ATTEMPTS:-3}
delay=${SMOKE_DELAY:-20}
err=$(mktemp)
trap 'rm -f "$err"' EXIT HUP INT TERM

# environmental: prints "bot-check", "rate-limited" or "network" if the error text is that, nothing otherwise.
classify() {
  text=$(tr '[:upper:]' '[:lower:]' < "$err")
  if printf '%s' "$text" | grep -Eq "confirm your age|age.restricted|inappropriate for some users"; then return 0; fi
  # the apostrophe in "you're" may be a 3-byte curly one, hence {1,3}
  if printf '%s' "$text" | grep -Eq "confirm you.{1,3}re not a bot"; then echo bot-check
  elif printf '%s' "$text" | grep -Eq "http error 429|too many requests|rate.?limit"; then echo rate-limited
  elif printf '%s' "$text" | grep -Eq "unable to download|timed out|name or service not known|temporary failure|connection (refused|reset)|network is unreachable|getaddrinfo"; then echo network
  fi
}

n=1
while :; do
  reason=""
  if out=$("$bin" --no-playlist --no-warnings -g -- "https://www.youtube.com/watch?v=$id" 2>"$err"); then
    if printf '%s\n' "$out" | grep -q '^https://'; then
      echo "smoke: resolved $id on attempt $n"
      exit 0
    fi
    echo "smoke: attempt $n/$attempts: yt-dlp succeeded but printed no https URL" >&2
  else
    reason=$(classify)
    # stderr is yt-dlp's own error text (no stream URLs), safe to show.
    echo "smoke: attempt $n/$attempts failed${reason:+ ($reason)}:" >&2
    tail -n 5 "$err" >&2
  fi
  if [ "$n" -ge "$attempts" ]; then
    if [ -n "$reason" ]; then
      echo "smoke: inconclusive after $attempts attempts ($reason: the environment, not necessarily yt-dlp)" >&2
      exit 3
    fi
    echo "smoke: giving up after $attempts attempts" >&2
    exit 1
  fi
  n=$((n + 1))
  sleep "$delay"
done
