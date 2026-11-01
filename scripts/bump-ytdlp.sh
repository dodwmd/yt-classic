#!/bin/sh
# Pin a yt-dlp release in backend/Containerfile and shell.nix, after verifying the downloaded binary against the
# release's SHA2-256SUMS. Idempotent: running it again with the same release changes nothing.
#
#   bump-ytdlp.sh VERSION SUMS_FILE BINARY_FILE [CONTAINERFILE [SHELL_NIX]]
#
# VERSION      release tag, e.g. 2026.10.26
# SUMS_FILE    the release's SHA2-256SUMS ("<sha256>  <file name>" lines)
# BINARY_FILE  the downloaded release asset named "yt-dlp"
# Environment (all optional):
#   SUMS_SIG     the release's SHA2-256SUMS.sig. If set, the signature over SUMS_FILE must be valid and made by the
#                pinned yt-dlp signing key (scripts/yt-dlp-release.pub, fingerprint below), or nothing is pinned.
#   YTDLP_PUBKEY, YTDLP_KEY_FPR   override the key file and fingerprint (tests only).
#
# Prints "updated" or "unchanged" on stdout (everything else goes to stderr). Exits non-zero, touching nothing, if
# anything does not check out. A matching checksum alone proves the download is intact, not who published it; the
# signature adds that. shell.nix gets the hex digest (fetchurl takes hex or nix-base32 here, not SRI), so no nix
# tooling is needed to run this.
set -eu

die() {
  echo "bump-ytdlp: $*" >&2
  exit 1
}

if ! { [ "$#" -ge 3 ] && [ "$#" -le 5 ]; }; then
  die "usage: bump-ytdlp.sh VERSION SUMS_FILE BINARY_FILE [CONTAINERFILE [SHELL_NIX]]"
fi
version=$1
sums=$2
binary=$3
here=$(cd "$(dirname "$0")" && pwd)
containerfile=${4:-$here/../backend/Containerfile}
shellnix=${5:-$here/../shell.nix}

# Where this key comes from: the yt-dlp project publishes it at https://github.com/yt-dlp/yt-dlp/blob/master/public.key
# (linked from its README, "Release Files"). It was copied into this repo on 2026-11-02 and the fingerprint below was
# computed from that copy (gpg --show-keys); yt-dlp does not publish the fingerprint anywhere separately. Trust is
# therefore "the key the project's repo served on that day", reviewable in this repository's history. If the project
# rotates its key, verification fails closed and a human has to review and replace both.
key=${YTDLP_PUBKEY:-$here/yt-dlp-release.pub}
fpr=${YTDLP_KEY_FPR:-AC0CBBE6848D6A873464AF4E57CF65933B5A7581}

printf '%s\n' "$version" | grep -Eq '^[0-9]{4}\.[0-9]{2}\.[0-9]{2}(\.[0-9]+)?$' || die "unexpected version format: $version"
[ -f "$sums" ] || die "no such file: $sums"
[ -f "$binary" ] || die "no such file: $binary"
[ -f "$containerfile" ] || die "no such file: $containerfile"
[ -f "$shellnix" ] || die "no such file: $shellnix"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT HUP INT TERM

if [ -n "${SUMS_SIG:-}" ]; then
  [ -f "$SUMS_SIG" ] || die "no such file: $SUMS_SIG"
  [ -f "$key" ] || die "no such file: $key"
  command -v gpg >/dev/null 2>&1 || die "gpg is needed to verify the signature"
  mkdir -m 700 "$tmp/gnupg"
  GNUPGHOME=$tmp/gnupg gpg --batch --quiet --import "$key" 2>/dev/null || die "cannot import $key"
  status=$(GNUPGHOME=$tmp/gnupg gpg --batch --status-fd 1 --verify "$SUMS_SIG" "$sums" 2>/dev/null) || die "SIGNATURE INVALID for SHA2-256SUMS (or signed by an unknown key). Refusing to pin."
  printf '%s\n' "$status" | awk -v f="$fpr" '$2 == "VALIDSIG" && ($3 == f || $NF == f) { ok = 1 } END { exit !ok }' ||
    die "SHA2-256SUMS is signed, but not by the pinned key $fpr. Refusing to pin."
  echo "bump-ytdlp: SHA2-256SUMS signature verified (key $fpr)" >&2
fi

# The published digest for exactly the file "yt-dlp" (not yt-dlp_linux, yt-dlp.exe, ...).
expected=$(awk '$2 == "yt-dlp" || $2 == "*yt-dlp" { print $1 }' "$sums")
[ -n "$expected" ] || die "SHA2-256SUMS has no entry for yt-dlp"
[ "$(printf '%s\n' "$expected" | wc -l)" -eq 1 ] || die "SHA2-256SUMS has several entries for yt-dlp"
printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' || die "malformed digest in SHA2-256SUMS"

actual=$(sha256sum "$binary" | awk '{ print $1 }')
[ "$actual" = "$expected" ] || die "CHECKSUM MISMATCH for yt-dlp $version: published $expected, downloaded $actual. Refusing to pin."

# Each pattern must match exactly one line, otherwise the file changed shape and a human has to look.
need_one() {
  [ "$(grep -Ec "$1" "$2")" -eq 1 ] || die "expected exactly one line matching $1 in $2"
}
need_one '^ARG YTDLP_VERSION=' "$containerfile"
need_one '^ARG YTDLP_SHA256=' "$containerfile"
need_one '^ *ytDlpVersion = "[^"]*";' "$shellnix"
need_one '^ *sha256 = "[^"]*";' "$shellnix"

sed -e "s|^ARG YTDLP_VERSION=.*|ARG YTDLP_VERSION=$version|" \
    -e "s|^ARG YTDLP_SHA256=.*|ARG YTDLP_SHA256=$expected|" "$containerfile" > "$tmp/Containerfile"
sed -e "s|^\( *\)ytDlpVersion = \"[^\"]*\";|\1ytDlpVersion = \"$version\";|" \
    -e "s|^\( *\)sha256 = \"[^\"]*\";|\1sha256 = \"$expected\";|" "$shellnix" > "$tmp/shell.nix"

if cmp -s "$tmp/Containerfile" "$containerfile" && cmp -s "$tmp/shell.nix" "$shellnix"; then
  echo unchanged
  exit 0
fi
# cat (not mv) keeps the files' modes and ownership.
cat "$tmp/Containerfile" > "$containerfile"
cat "$tmp/shell.nix" > "$shellnix"
echo updated
