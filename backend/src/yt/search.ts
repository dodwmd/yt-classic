import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cached } from "../cache.ts";
import { formatSeconds } from "../format.ts";
import { apiSearch, type SearchPage, type VideoSummary } from "./api.ts";
import { resolveSlots } from "./dlp.ts";

const run = promisify(execFile);
const PAGE = 20;
const MAX_PAGES = 5;
export const MAX_QUERY = 200;

export function parseSearch(json: any, page: number): SearchPage {
  const entries: any[] = (json.entries ?? []).filter((e: any) => typeof e?.id === "string" && e.id.length === 11);
  const items: VideoSummary[] = entries.slice((page - 1) * PAGE).map((e) => ({
    id: e.id,
    title: e.title ?? "",
    channelId: e.channel_id ?? "",
    channelTitle: e.channel ?? e.uploader ?? "",
    description: e.description ?? "",
    publishedAt: "", // flat search results carry no publish date
    thumb: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
    durationLabel: typeof e.duration === "number" ? formatSeconds(e.duration) : undefined,
    views: e.view_count != null ? String(e.view_count) : undefined,
  }));
  return {
    items,
    nextPageToken: page < MAX_PAGES && items.length >= PAGE ? String(page + 1) : undefined,
    prevPageToken: page > 1 ? String(page - 1) : undefined,
  };
}

// The Data API fallback costs 100 quota units a search, so cap how often it can be used per day.
let fallbackDay = "";
let fallbackUsed = 0;
function fallbackAllowed(): boolean {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== fallbackDay) [fallbackDay, fallbackUsed] = [day, 0];
  return fallbackUsed++ < Number(process.env.SEARCH_FALLBACK_MAX ?? 20);
}

/**
 * Page tokens: "2".."5" are yt-dlp pages; "g:<token>" are Data API page tokens (only produced by the fallback).
 * Anything else is treated as page 1.
 */
export function search(q: string, pageToken = ""): Promise<SearchPage> {
  if (pageToken.startsWith("g:")) return apiPage(q, pageToken.slice(2));
  const page = /^\d{1,2}$/.test(pageToken) ? Math.min(MAX_PAGES, Math.max(1, Number(pageToken))) : 1;
  return cached(`ytsearch:${q}:${page}`, 10 * 60_000, async () => {
    try {
      const { stdout } = await resolveSlots.run(() =>
        run(process.env.YTDLP_BIN ?? "yt-dlp", ["--flat-playlist", "--no-warnings", "-J", `ytsearch${PAGE * page}:${q}`], {
          timeout: 45_000,
          maxBuffer: 32 * 1024 * 1024,
        }),
      );
      return parseSearch(JSON.parse(stdout), page);
    } catch (e) {
      console.error(`yt-dlp search failed: ${(e as Error).message.split("\n")[0]}`);
      if (page > 1 || !fallbackAllowed()) throw e;
      return apiPage(q, "");
    }
  });
}

async function apiPage(q: string, token: string): Promise<SearchPage> {
  const p = await apiSearch(q, token);
  return {
    items: p.items,
    nextPageToken: p.nextPageToken && `g:${p.nextPageToken}`,
    prevPageToken: p.prevPageToken && `g:${p.prevPageToken}`,
  };
}
