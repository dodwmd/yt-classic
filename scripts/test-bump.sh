#!/bin/sh
# Offline tests for bump-ytdlp.sh and smoke-ytdlp.sh: fixtures are generated in a temp dir, nothing touches the
# network or the real Containerfile/shell.nix. Run: scripts/test-bump.sh
set -u

here=$(cd "$(dirname "$0")" && pwd)
root=$here/..
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT HUP INT TERM
fails=0
count=0

ok() { count=$((count + 1)); echo "ok $count - $1"; }
bad() { count=$((count + 1)); fails=$((fails + 1)); echo "not ok $count - $1"; }
check() { # description, command...
  desc=$1
  shift
  if "$@"; then ok "$desc"; else bad "$desc"; fi
}

# A fresh copy of the real pinned files plus a fake release (binary, SHA2-256SUMS) for version $1.
fixture() {
  d=$work/$2
  mkdir -p "$d"
  cp "$root/backend/Containerfile" "$d/Containerfile"
  cp "$root/shell.nix" "$d/shell.nix"
  printf '#!/bin/sh\necho fake yt-dlp %s\n' "$1" > "$d/yt-dlp"
  sha=$(sha256sum "$d/yt-dlp" | awk '{ print $1 }')
  {
    echo "0000000000000000000000000000000000000000000000000000000000000000  yt-dlp.exe"
    echo "$sha  yt-dlp"
    echo "1111111111111111111111111111111111111111111111111111111111111111  yt-dlp_linux"
  } > "$d/SHA2-256SUMS"
  echo "$sha" > "$d/sha"
}
bump() { # fixture dir, version
  sh "$here/bump-ytdlp.sh" "$2" "$1/SHA2-256SUMS" "$1/yt-dlp" "$1/Containerfile" "$1/shell.nix"
}
same() { cmp -s "$1" "$2"; }
has() { grep -qF -- "$2" "$1"; }
text_has() { printf '%s\n' "$1" | grep -qF -- "$2"; }
text_lacks() { ! text_has "$1" "$2"; }

# --- happy path -----------------------------------------------------------------------------------------------
fixture 2099.01.02 good
sha=$(cat "$work/good/sha")
out=$(bump "$work/good" 2099.01.02)
check "reports updated" test "$out" = updated
check "Containerfile version" has "$work/good/Containerfile" "ARG YTDLP_VERSION=2099.01.02"
check "Containerfile sha256" has "$work/good/Containerfile" "ARG YTDLP_SHA256=$sha"
check "shell.nix version" has "$work/good/shell.nix" 'ytDlpVersion = "2099.01.02";'
check "shell.nix sha256" has "$work/good/shell.nix" "sha256 = \"$sha\";"
check "only the pins changed in Containerfile" test "$(diff "$root/backend/Containerfile" "$work/good/Containerfile" | grep -c '^>')" -eq 2
check "only the pins changed in shell.nix" test "$(diff "$root/shell.nix" "$work/good/shell.nix" | grep -c '^>')" -eq 2

# --- idempotent -----------------------------------------------------------------------------------------------
cp "$work/good/Containerfile" "$work/c1"
cp "$work/good/shell.nix" "$work/s1"
out=$(bump "$work/good" 2099.01.02)
check "second run reports unchanged" test "$out" = unchanged
check "second run leaves Containerfile byte-identical" same "$work/c1" "$work/good/Containerfile"
check "second run leaves shell.nix byte-identical" same "$work/s1" "$work/good/shell.nix"

# --- a later release bumps again ------------------------------------------------------------------------------
fixture 2099.02.03 next
cp "$work/good/Containerfile" "$work/next/Containerfile"
cp "$work/good/shell.nix" "$work/next/shell.nix"
out=$(bump "$work/next" 2099.02.03)
check "newer release updates the previous pin" test "$out" = updated
check "no trace of the old version left" test "$(grep -c 2099.01.02 "$work/next/Containerfile" "$work/next/shell.nix" | grep -vc ':0')" -eq 0

# --- bad checksum: refuse and touch nothing -------------------------------------------------------------------
fixture 2099.03.04 tampered
printf 'malware' >> "$work/tampered/yt-dlp"
cp "$work/tampered/Containerfile" "$work/c2"
cp "$work/tampered/shell.nix" "$work/s2"
msg=$(bump "$work/tampered" 2099.03.04 2>&1)
bump "$work/tampered" 2099.03.04 >/dev/null 2>&1
check "tampered binary exit status is non-zero" test $? -ne 0
check "tampered binary: message says mismatch" text_has "$msg" "CHECKSUM MISMATCH"
check "tampered binary: Containerfile untouched" same "$work/c2" "$work/tampered/Containerfile"
check "tampered binary: shell.nix untouched" same "$work/s2" "$work/tampered/shell.nix"

# --- the sums file lists only other files ---------------------------------------------------------------------
fixture 2099.04.05 nosum
grep -v ' yt-dlp$' "$work/nosum/SHA2-256SUMS" > "$work/nosum/S" && mv "$work/nosum/S" "$work/nosum/SHA2-256SUMS"
bump "$work/nosum" 2099.04.05 >/dev/null 2>&1
check "missing yt-dlp entry is refused" test $? -ne 0
check "missing entry: Containerfile untouched" same "$root/backend/Containerfile" "$work/nosum/Containerfile"

# --- malformed input ------------------------------------------------------------------------------------------
fixture 2099.05.06 badver
bump "$work/badver" 'latest; rm -rf /' >/dev/null 2>&1
check "bad version string is refused" test $? -ne 0
fixture 2099.05.07 badsum
echo "nothex  yt-dlp" > "$work/badsum/SHA2-256SUMS"
bump "$work/badsum" 2099.05.07 >/dev/null 2>&1
check "malformed digest is refused" test $? -ne 0
fixture 2099.05.08 dupe
echo "$(cat "$work/dupe/sha")  yt-dlp" >> "$work/dupe/SHA2-256SUMS"
bump "$work/dupe" 2099.05.08 >/dev/null 2>&1
check "duplicate entries are refused" test $? -ne 0

# --- the pin file changed shape -------------------------------------------------------------------------------
fixture 2099.06.07 shape
grep -v '^ARG YTDLP_SHA256=' "$work/shape/Containerfile" > "$work/shape/C" && mv "$work/shape/C" "$work/shape/Containerfile"
bump "$work/shape" 2099.06.07 >/dev/null 2>&1
check "a Containerfile without the sha pin is refused" test $? -ne 0

# --- the real files really are in the shape the script expects (catches drift) --------------------------------
check "real Containerfile has both pins" test "$(grep -Ec '^ARG YTDLP_(VERSION|SHA256)=' "$root/backend/Containerfile")" -eq 2
check "real shell.nix has both pins" test "$(grep -Ec '^ *(ytDlpVersion|sha256) = "' "$root/shell.nix")" -eq 2

# --- signatures (needs gpg) -----------------------------------------------------------------------------------
if command -v gpg >/dev/null 2>&1; then
  # real release data, real committed key and pinned fingerprint
  td=$here/testdata
  real=$work/real
  mkdir -p "$real"
  cp "$td/SHA2-256SUMS.2026.10.26" "$real/SHA2-256SUMS"
  cp "$td/SHA2-256SUMS.2026.10.26.sig" "$real/SHA2-256SUMS.sig"
  yt_sha=$(awk '$2 == "yt-dlp" { print $1 }' "$real/SHA2-256SUMS")
  check "committed key verifies the real 2026.10.26 signature (via a stand-in binary: expect checksum mismatch, not a signature error)" \
    text_has "$(SUMS_SIG=$real/SHA2-256SUMS.sig sh "$here/bump-ytdlp.sh" 2026.10.26 "$real/SHA2-256SUMS" "$work/good/yt-dlp" "$work/good/Containerfile" "$work/good/shell.nix" 2>&1)" "signature verified"
  check "the real sums file's digest is $yt_sha" test "${#yt_sha}" -eq 64
  # a tampered sums file no longer matches the real signature
  sed 's/^./0/' "$real/SHA2-256SUMS" > "$real/tampered"
  m=$(SUMS_SIG=$real/SHA2-256SUMS.sig sh "$here/bump-ytdlp.sh" 2026.10.26 "$real/tampered" "$work/good/yt-dlp" "$work/good/Containerfile" "$work/good/shell.nix" 2>&1)
  check "tampered sums are refused by signature" text_has "$m" "SIGNATURE INVALID"
  # a valid signature by some other key is refused
  gh=$work/gh
  mkdir -m 700 "$gh"
  GNUPGHOME=$gh gpg --batch --quiet --pinentry-mode loopback --passphrase '' --quick-generate-key "other <o@example.invalid>" ed25519 sign never 2>/dev/null
  fixture 2099.07.08 sig
  GNUPGHOME=$gh gpg --batch --quiet --detach-sign -o "$work/sig/SHA2-256SUMS.sig" "$work/sig/SHA2-256SUMS"
  GNUPGHOME=$gh gpg --batch --quiet --export --armor > "$work/other.pub"
  other_fpr=$(GNUPGHOME=$gh gpg --batch --with-colons --list-keys | awk -F: '$1 == "fpr" { print $10; exit }')
  m=$(SUMS_SIG=$work/sig/SHA2-256SUMS.sig sh "$here/bump-ytdlp.sh" 2099.07.08 "$work/sig/SHA2-256SUMS" "$work/sig/yt-dlp" "$work/sig/Containerfile" "$work/sig/shell.nix" 2>&1)
  check "a good signature by an unknown key is refused (default pinned key)" text_has "$m" "SIGNATURE INVALID"
  out=$(SUMS_SIG=$work/sig/SHA2-256SUMS.sig YTDLP_PUBKEY=$work/other.pub YTDLP_KEY_FPR=$other_fpr sh "$here/bump-ytdlp.sh" 2099.07.08 "$work/sig/SHA2-256SUMS" "$work/sig/yt-dlp" "$work/sig/Containerfile" "$work/sig/shell.nix" 2>/dev/null)
  check "a good signature by the configured key is accepted and pins" test "$out" = updated
  fixture 2099.07.09 sig2
  GNUPGHOME=$gh gpg --batch --quiet --detach-sign -o "$work/sig2/SHA2-256SUMS.sig" "$work/sig2/SHA2-256SUMS"
  m=$(SUMS_SIG=$work/sig2/SHA2-256SUMS.sig YTDLP_PUBKEY=$work/other.pub YTDLP_KEY_FPR=0000000000000000000000000000000000000000 sh "$here/bump-ytdlp.sh" 2099.07.09 "$work/sig2/SHA2-256SUMS" "$work/sig2/yt-dlp" "$work/sig2/Containerfile" "$work/sig2/shell.nix" 2>&1)
  check "a valid signature by a key other than the pinned fingerprint is refused" text_has "$m" "not by the pinned key"
  check "...and leaves the pins alone" same "$root/backend/Containerfile" "$work/sig2/Containerfile"
else
  echo "# gpg not installed: signature tests skipped (CI has gpg)"
fi

# --- smoke script ---------------------------------------------------------------------------------------------
printf '#!/bin/sh\necho https://rr1.example.invalid/videoplayback\n' > "$work/yt-ok"
printf '#!/bin/sh\necho "ERROR: [youtube] jNQXAC9IVRw: Sign in to confirm you\342\200\231re not a bot" >&2\nexit 1\n' > "$work/yt-fail"
printf '#!/bin/sh\necho not-a-url\n' > "$work/yt-junk"
# fails the first call, succeeds the second: proves retry
cat > "$work/yt-flaky" <<'FLAKY'
#!/bin/sh
f=MARKER
if [ -e "$f" ]; then echo https://x.invalid/v; else : > "$f"; echo "ERROR: timed out" >&2; exit 1; fi
FLAKY
sed "s|MARKER|$work/flaky|" "$work/yt-flaky" > "$work/yt-flaky.tmp" && mv "$work/yt-flaky.tmp" "$work/yt-flaky"
chmod +x "$work"/yt-*
out=$(SMOKE_DELAY=0 sh "$here/smoke-ytdlp.sh" "$work/yt-ok" 2>&1)
check "smoke passes when a URL resolves" test $? -eq 0
check "smoke never prints the stream URL" text_lacks "$out" invalid
SMOKE_DELAY=0 sh "$here/smoke-ytdlp.sh" "$work/yt-flaky" >/dev/null 2>&1
check "smoke retries a transient failure" test $? -eq 0
SMOKE_DELAY=0 SMOKE_ATTEMPTS=2 sh "$here/smoke-ytdlp.sh" "$work/yt-fail" >/dev/null 2>&1
check "smoke: a bot-check is inconclusive (exit 3), not a regression" test $? -eq 3
SMOKE_DELAY=0 SMOKE_ATTEMPTS=1 sh "$here/smoke-ytdlp.sh" "$work/yt-junk" >/dev/null 2>&1
check "smoke: output that is not a URL is a real failure (exit 1)" test $? -eq 1
smoke_with_error() { # error text -> exit status of a smoke run whose yt-dlp always fails with it
  printf '#!/bin/sh\necho "%s" >&2\nexit 1\n' "$1" > "$work/yt-err"
  chmod +x "$work/yt-err"
  SMOKE_DELAY=0 SMOKE_ATTEMPTS=1 sh "$here/smoke-ytdlp.sh" "$work/yt-err" >/dev/null 2>&1
  echo $?
}
check "smoke: HTTP 429 is inconclusive" test "$(smoke_with_error 'ERROR: HTTP Error 429: Too Many Requests')" -eq 3
check "smoke: no network is inconclusive" test "$(smoke_with_error 'ERROR: Unable to download webpage: Temporary failure in name resolution')" -eq 3
check "smoke: a Python crash is a real failure" test "$(smoke_with_error 'Traceback (most recent call last): KeyError: x')" -eq 1
check "smoke: an extractor error is a real failure" test "$(smoke_with_error 'ERROR: [youtube] jNQXAC9IVRw: Unable to extract player response')" -eq 1
check "smoke: age-gate text is not mistaken for a bot-check" test "$(smoke_with_error 'ERROR: Sign in to confirm your age')" -eq 1

echo "1..$count"
[ "$fails" -eq 0 ] || { echo "$fails failed" >&2; exit 1; }
