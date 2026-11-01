# Android dev shell for the YouTube Classic app: `nix-shell android/shell.nix` (from the repo root) or
# `cd android && nix-shell`. Kept separate from the root shell.nix because the SDK is several GB.
{ pkgs ? import <nixpkgs> {
    config = {
      allowUnfree = true;
      android_sdk.accept_license = true;
    };
  }
, # `nix-shell --arg withEmulator true` adds an x86_64 emulator + system image (needs KVM; ~2 GB more).
  withEmulator ? false
}:

let
  buildTools = "36.1.0";
  android = pkgs.androidenv.composeAndroidPackages {
    platformVersions = [ "36" ]; # the Nix SDK base; platform 37 is added below
    buildToolsVersions = [ buildTools ];
    includeEmulator = withEmulator;
    includeSystemImages = withEmulator;
    systemImageTypes = [ "google_apis" ];
    abiVersions = [ "x86_64" ];
    includeNDK = false;
  };
  # The newest Android libraries (Compose, OkHttp, ...) need compileSdk 37, which this nixpkgs' SDK repo does not
  # have yet. Fetch the platform from Google (hash-pinned; sha1 matches the one Google publishes) and compose a
  # read-only SDK = the Nix one + platform 37, so Gradle never has to install anything.
  platform37 = pkgs.fetchurl {
    url = "https://dl.google.com/android/repository/platform-37.0_r02.zip";
    sha256 = "138f6f8di5f7qlqv5v9pmmmmzp63maa136n8ljp68vpr4zl262w4";
  };
  sdkRoot = pkgs.runCommand "android-sdk-with-37" { nativeBuildInputs = [ pkgs.unzip ]; } ''
    base=${android.androidsdk}/libexec/android-sdk
    sdk=$out/libexec/android-sdk
    mkdir -p $sdk/platforms
    for d in $base/*; do [ "$(basename $d)" = platforms ] || ln -s $d $sdk/$(basename $d); done
    for d in $base/platforms/*; do ln -s $d $sdk/platforms/$(basename $d); done
    unzip -q ${platform37} -d $TMPDIR/p
    mv $TMPDIR/p/android-37.0 $sdk/platforms/android-37.0
    ln -s android-37.0 $sdk/platforms/android-37
    # Google's zip has no package.xml (the SDK manager's "installed" marker); write the one Gradle looks for.
    cat > $sdk/platforms/android-37.0/package.xml <<'XML'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/02" xmlns:ns11="http://schemas.android.com/sdk/android/repo/repository2/03" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <license id="android-sdk-license" type="text">Android SDK License; accepted via the licenses directory.</license>
  <localPackage path="platforms;android-37.0" obsolete="false">
    <type-details xsi:type="ns11:platformDetailsType"><api-level>37.0</api-level><base-extension>true</base-extension><extension-level>22</extension-level><layoutlib api="15"/></type-details>
    <revision><major>2</major></revision>
    <display-name>Android SDK Platform 37.0</display-name>
    <uses-license ref="android-sdk-license"/>
  </localPackage>
</ns2:repository>
XML
  '';
  sdk = "${sdkRoot}/libexec/android-sdk";
in
pkgs.mkShell {
  name = "yt-classic-android";

  packages = [
    pkgs.jdk17
    pkgs.gradle # only used to bootstrap the wrapper; the project then uses ./gradlew
    android.androidsdk
    pkgs.android-tools # adb, for installing the APK on a phone
  ];

  JAVA_HOME = "${pkgs.jdk17}";
  ANDROID_HOME = sdk;
  ANDROID_SDK_ROOT = sdk;
  # Gradle's Android plugin downloads a prebuilt aapt2 that cannot run on NixOS; use the SDK's instead.
  GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${sdk}/build-tools/${buildTools}/aapt2";
}
