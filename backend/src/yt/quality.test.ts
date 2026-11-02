import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { autoQuality, baseQualities, ffmpegArgs, formatSelector, knownOffered, offeredFrom, parseCodecs, parseQuality, requestedQuality, resolveUrls } from "./dlp.ts";

const fixture = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"));
const withEnv = (k: string, v: string | undefined, fn: () => void) => {
  const old = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
  try { fn(); } finally { if (old === undefined) delete process.env[k]; else process.env[k] = old; }
};

test("parseQuality: bounds, new tiers and the MAX_QUALITY cap", () => {
  for (const q of [360, 480, 720, 1080, 1440, 2160]) assert.equal(parseQuality(String(q)), q);
  for (const bad of ["999", "0", "-720", "4320", "abc", "", "auto", null]) assert.equal(parseQuality(bad), 720, String(bad));
  withEnv("MAX_QUALITY", "1080", () => {
    assert.equal(parseQuality("2160"), 720, "above the owner's cap falls back to the default");
    assert.equal(parseQuality("1080"), 1080);
    assert.deepEqual(baseQualities(), [360, 480, 720, 1080]);
  });
  withEnv("MAX_QUALITY", "480", () => {
    assert.equal(parseQuality("720"), 480, "a cap below the default clamps the default too");
    assert.deepEqual(baseQualities(), [360, 480]);
  });
  assert.deepEqual(baseQualities(), [360, 480, 720, 1080]);
});

test("parseCodecs: names, aliases, absent means all, unknown means H.264", () => {
  assert.deepEqual(parseCodecs(null), ["avc1", "vp9", "av01"]);
  assert.deepEqual(parseCodecs("av1,vp9"), ["vp9", "av01"]);
  assert.deepEqual(parseCodecs("AVC1, vp09 ,h264"), ["avc1", "vp9"]);
  assert.deepEqual(parseCodecs("bogus"), ["avc1"]);
});

test("autoQuality: screen height, decoders and what the video has", () => {
  const all = parseCodecs(null), h264 = parseCodecs("avc1");
  assert.equal(autoQuality(null, all), 1080, "no maxh: the 1080p default");
  assert.equal(autoQuality("2160", all), 2160);
  assert.equal(autoQuality("2160", h264), 1080, "H.264 cannot go above 1080p");
  assert.equal(autoQuality("1440", parseCodecs("vp9")), 1440);
  assert.equal(autoQuality("1200", all), 1080, "the highest tier that fits the screen");
  assert.equal(autoQuality("720", all), 720);
  assert.equal(autoQuality("100", all), 360, "never below the lowest tier");
  assert.equal(autoQuality("junk", all), 1080);
  assert.equal(autoQuality("2160", all, [360, 720]), 720, "the video's own highest tier under the cap");
  assert.equal(autoQuality("2160", all, [1080, 2160]), 2160);
  withEnv("MAX_QUALITY", "1440", () => assert.equal(autoQuality("2160", all), 1440));
  assert.equal(requestedQuality(new URLSearchParams("q=auto&maxh=1440&codecs=avc1,vp9")).quality, 1440);
  assert.equal(requestedQuality(new URLSearchParams("q=auto&maxh=1440&codecs=avc1")).quality, 1080);
  assert.equal(requestedQuality(new URLSearchParams("q=1440")).auto, false);
});

test("formatSelector: unchanged up to 1080p, VP9 then AV1 above, only decodable codecs", () => {
  const old = (q: number) => `bv*[height<=${q}][vcodec^=avc1]+ba[ext=m4a][language^=en]/bv*[height<=${q}][ext=mp4]+ba[ext=m4a][language^=en]/bv*[height<=${q}][vcodec^=avc1]+ba[ext=m4a]/bv*[height<=${q}][ext=mp4]+ba[ext=m4a]/b[height<=${q}][ext=mp4]/bv*[height<=${q}]+ba/b[height<=${q}]`;
  for (const q of [360, 480, 720, 1080]) assert.equal(formatSelector(q, "en"), old(q), `${q}p is what it always was`);
  assert.equal(formatSelector(1080, "en", ["avc1"]), old(1080));
  const hi = formatSelector(2160, "pt");
  assert.ok(hi.startsWith("bv*[height<=2160][height>1080][vcodec~='^vp0?9'][protocol!*=m3u8]+ba[ext=m4a][language^=pt]/"), hi);
  assert.ok(hi.indexOf("vcodec~='^vp0?9'") < hi.indexOf("vcodec~='^av01'"), "VP9 before AV1");
  assert.ok(hi.indexOf("vcodec~='^av01'") < hi.indexOf("[vcodec^=avc1]"), "H.264 is the fallback");
  assert.ok(hi.includes("[height<=2160][height>1080][vcodec~='^vp0?9'][protocol!*=m3u8]+ba/"), "any audio (Opus) as a last resort");
  assert.ok(formatSelector(1440, "en").includes("height<=1440][height>1080]"));
  const onlyVp9 = formatSelector(2160, "en", ["avc1", "vp9"]);
  assert.ok(!onlyVp9.includes("^av01'][protocol") && onlyVp9.includes("[vcodec!~='^av01']"), onlyVp9);
  const onlyAv1 = formatSelector(2160, "en", ["avc1", "av01"]);
  assert.ok(!onlyAv1.includes("vcodec~='^vp0?9'") && onlyAv1.includes("[vcodec!~='^vp0?9']"), onlyAv1);
  assert.equal(formatSelector(2160, "en", ["avc1"]), old(1080), "no VP9/AV1 decoder: capped at 1080p");
});

test("offeredFrom real-shaped format lists", () => {
  const k4 = offeredFrom(fixture("formats-4k.json"));
  assert.deepEqual(k4.qualities, [360, 480, 720, 1080, 1440, 2160]);
  assert.deepEqual(k4.codecs["2160"], ["vp9", "av1"], "no H.264 above 1080p; HLS-only entries do not count");
  assert.deepEqual(k4.codecs["1080"], ["avc1", "vp9", "av1"]);
  const small = offeredFrom(fixture("formats-240p.json"));
  assert.deepEqual(small.qualities, [360], "a 240p-only video offers just the lowest tier");
  withEnv("MAX_QUALITY", "1440", () => assert.deepEqual(offeredFrom(fixture("formats-4k.json")).qualities.at(-1), 1440));
  const only720 = offeredFrom([{ height: 720, vcodec: "avc1.4d401f", protocol: "https" }, { height: 480, vcodec: "avc1.4d401e", protocol: "https" }, { vcodec: "none", protocol: "https" }]);
  assert.deepEqual(only720, { qualities: [480, 720], codecs: { "480": ["avc1"], "720": ["avc1"] } });
  const vp9Only4k = offeredFrom([{ height: 2160, vcodec: "vp9", protocol: "https" }, { height: 1080, vcodec: "vp09.00.40.08", protocol: "https" }]);
  assert.deepEqual(vp9Only4k, { qualities: [1080, 2160], codecs: { "1080": ["vp9"], "2160": ["vp9"] } });
  const av1Only = offeredFrom([{ height: 1440, vcodec: "av01.0.12M.08", protocol: "https" }]);
  assert.deepEqual(av1Only.codecs, { "1440": ["av1"] });
  const wide = offeredFrom([{ height: 816, vcodec: "avc1.640028", protocol: "https" }]); // a 1080p-class 2.35:1 video
  assert.deepEqual(wide.qualities, [1080]);
  assert.deepEqual(offeredFrom([{ height: 720, vcodec: "avc1", protocol: "m3u8_native" }, { height: "x" }, {}]).qualities, []);
});

test("resolveUrls asks yt-dlp for the selector and the format list in one run, and remembers the tiers", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "yt-quality-"));
  const argsFile = join(tmp, "args");
  const bin = join(tmp, "yt-dlp");
  writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho 'YTFMT [{"height":2160,"vcodec":"vp9","protocol":"https"},{"height":720,"vcodec":"avc1.4d401f","protocol":"https"}]'\necho https://v.invalid/v\necho https://a.invalid/a\n`);
  chmodSync(bin, 0o755);
  const saved = process.env.YTDLP_BIN;
  process.env.YTDLP_BIN = bin;
  try {
    const urls = await resolveUrls("QQQQQQQQQQQ", 2160, "en", ["avc1", "vp9"]);
    assert.deepEqual(urls, ["https://v.invalid/v", "https://a.invalid/a"], "the tagged line is not a URL");
    const args = readFileSync(argsFile, "utf8").split("\n");
    assert.equal(args[args.indexOf("-f") + 1], formatSelector(2160, "en", ["avc1", "vp9"]));
    assert.ok(args.includes("-g"));
    assert.deepEqual(knownOffered("QQQQQQQQQQQ")?.qualities, [720, 2160]);
    assert.equal(knownOffered("RRRRRRRRRRR"), undefined);
  } finally {
    if (saved === undefined) delete process.env.YTDLP_BIN; else process.env.YTDLP_BIN = saved;
    rmSync(tmp, { recursive: true, force: true });
  }
});

// A real remux: a tiny generated clip, encoded like YouTube's high-resolution DASH files (VP9/AV1 video, Opus audio in
// webm), goes through the very arguments the server uses (-c copy into fragmented mp4) and is checked with ffprobe.
const has = (bin: string, args: string[]) => spawnSync(bin, args, { stdio: "ignore" }).status === 0;
const encoders = has("ffmpeg", ["-version"]) && has("ffprobe", ["-version"]) ? execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" }) : "";
const lavfi = ["-f", "lavfi", "-i", "testsrc=size=320x180:rate=15:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2"];

function remuxSmoke(vcodecArgs: string[], expectVideo: string, expectTag: string) {
  const tmp = mkdtempSync(join(tmpdir(), "yt-remux-"));
  try {
    const video = join(tmp, "v.webm"), audio = join(tmp, "a.webm");
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...lavfi.slice(0, 4), ...vcodecArgs, "-an", video]);
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", ...lavfi.slice(4), "-c:a", "libopus", audio]);
    // The server's own arguments, with local files instead of googlevideo URLs (so no http-only -reconnect options).
    const full = ffmpegArgs([video, audio], 0);
    const args: string[] = [];
    for (let i = 0; i < full.length; i++) {
      if (full[i].startsWith("-reconnect")) i++;
      else if (full[i] === "-protocol_whitelist") i++;
      else args.push(full[i]);
    }
    const out = join(tmp, "o.mp4");
    execFileSync("ffmpeg", [...args.slice(0, -1), "-y", out]);
    const probe = execFileSync("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,codec_name,codec_tag_string", "-of", "csv=p=0", out], { encoding: "utf8" });
    assert.match(probe, new RegExp(`${expectVideo},video,${expectTag}`), probe);
    assert.match(probe, /opus,audio,Opus/, `Opus audio is copied into mp4: ${probe}`);
    const format = execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=format_name", "-of", "csv=p=0", out], { encoding: "utf8" });
    assert.match(format, /mp4/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

test("remux -c copy: VP9 + Opus (webm) into fragmented mp4", { skip: !/libvpx-vp9/.test(encoders) || !/libopus/.test(encoders) && "ffmpeg without libvpx-vp9/libopus" }, () => {
  remuxSmoke(["-c:v", "libvpx-vp9", "-b:v", "200k"], "vp9", "vp09");
});

test("remux -c copy: AV1 + Opus (webm) into fragmented mp4", { skip: !/libaom-av1|libsvtav1/.test(encoders) || !/libopus/.test(encoders) && "ffmpeg without an AV1 encoder/libopus" }, () => {
  remuxSmoke(["-c:v", /libsvtav1/.test(encoders) ? "libsvtav1" : "libaom-av1", ...(/libsvtav1/.test(encoders) ? [] : ["-cpu-used", "8"])], "av1", "av01");
});
