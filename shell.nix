{ pkgs ? import <nixpkgs> {
    config = {
      allowUnfree = true;
    };
  }
}:


let
  claude-code-flake = builtins.getFlake "github:sadjow/claude-code-nix";
  claude-code = claude-code-flake.packages.${pkgs.system}.default;
  # nixpkgs lags behind YouTube breakage; pin the upstream release zipapp.
  yt-dlp-latest = pkgs.stdenvNoCC.mkDerivation {
    pname = "yt-dlp";
    version = "2026.10.26";
    src = pkgs.fetchurl {
      url = "https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp";
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
in

pkgs.mkShell {
  name = "yt-devshell";

  buildInputs = with pkgs; [
    terraform
    terramate
    kubectl
    kustomize
    kubernetes-helm
    opentofu
    git
    jq
    claude-code
    sops
    age
    git-filter-repo

    # yt project: backend (Node/TS), playback, containers, debugging
    nodejs_22
    yt-dlp-latest
    ffmpeg
    podman
    podman-compose
    curl
    htmlq
  ];
}
