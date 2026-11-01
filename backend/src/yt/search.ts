import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cached } from "../cache.ts";
import { formatSeconds } from "../format.ts";
import { apiSearch, type SearchPage, type VideoSummary } from "./api.ts";

const run = promisify(execFile);
const PAGE = 20;
const MAX_PAGES = 5;

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

/** Free search via yt-dlp. Falls back to the quota-costing Data API (first page only) if yt-dlp fails. */
export function search(q: string, pageToken = ""): Promise<SearchPage> {
  const page = Math.min(MAX_PAGES, Math.max(1, Number(pageToken) || 1));
  return cached(`ytsearch:${q}:${page}`, 10 * 60_000, async () => {
    try {
      const { stdout } = await run(
        "yt-dlp",
        ["--flat-playlist", "--no-warnings", "-J", `ytsearch${PAGE * page}:${q}`],
        { timeout: 45_000, maxBuffer: 32 * 1024 * 1024 },
      );
      return parseSearch(JSON.parse(stdout), page);
    } catch (e) {
      console.error(`yt-dlp search failed: ${(e as Error).message.split("\n")[0]}`);
      if (pageToken) throw e;
      return apiSearch(q);
    }
  });
}
