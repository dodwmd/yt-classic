import { channelUploads, type VideoDetail } from "./api.ts";
import { related, type RelatedItem } from "./innertube.ts";

export interface RelatedList {
  heading: string;
  items: RelatedItem[];
}

/** Real related videos; falls back to the channel's uploads (1 quota unit) if that breaks. */
export async function relatedFor(v: VideoDetail): Promise<RelatedList> {
  const items = await related(v.id).catch((e) => (console.error(e.message), [] as RelatedItem[]));
  if (items.length) return { heading: "Related videos", items };
  const ups = await channelUploads(v.channelId, v.id).catch(() => []);
  return {
    heading: `More from ${v.channelTitle}`,
    items: ups.map((u) => ({ id: u.id, title: u.title, channelTitle: v.channelTitle, publishedAt: u.publishedAt, thumb: u.thumb })),
  };
}
