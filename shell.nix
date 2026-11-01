# Dev shell for yt-classic: `nix-shell` (or direnv: `use nix`).
{ pkgs ? import <nixpkgs> { } }:

let
  # nixpkgs lags behind YouTube breakage, so pin the upstream yt-dlp release.
  # To update: run scripts/bump-ytdlp.sh (verifies the release checksum and signature and edits this file and
  # backend/Containerfile together; a weekly workflow does it as a PR). By hand: bump the version and set sha256 to
  # the release's SHA2-256SUMS entry for yt-dlp (hex) or the output of
  #   nix-prefetch-url https://github.com/yt-dlp/yt-dlp/releases/download/<version>/yt-dlp
  ytDlpVersion = "2026.10.26";
  yt-dlp-latest = pkgs.stdenvNoCC.mkDerivation {
    pname = "yt-dlp";
    version = ytDlpVersion;
    src = pkgs.fetchurl {
      url = "https://github.com/yt-dlp/yt-dlp/releases/download/${ytDlpVersion}/yt-dlp";
      sha256 = "1wzvbaq6s1isc1jg6hj8ycndngfs891jmlqk1x9rkwc9jkl6j7p5";
    };
    dontUnpack = true;
    nativeBuildInputs = [ pkgs.makeWrapper ];
    installPhase = ''
      install -Dm644 $src $out/lib/yt-dlp.zip
      makeWrapper ${pkgs.python3}/bin/python3 $out/bin/yt-dlp \
        --add-flags $out/lib/yt-dlp.zip --prefix PATH : ${pkgs.ffmpeg}/bin
    '';
  };

  # Optional, git-ignored personal additions (e.g. claude-code). See README.
  localPackages =
    if builtins.pathExists ./shell.local.nix
    then import ./shell.local.nix { inherit pkgs; }
    else [ ];
in
pkgs.mkShell {
  name = "yt-classic";

  packages = with pkgs; [
    # runtime
    nodejs_22
    yt-dlp-latest
    ffmpeg

    # containers
    podman
    podman-compose

    # debugging
    curl
    jq
    sqlite
    htmlq
    git
  ] ++ localPackages;
}
