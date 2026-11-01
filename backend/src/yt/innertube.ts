import { cached } from "../cache.ts";
import { fetchT } from "../http.ts";

export interface RelatedItem {
  id: string;
  title: string;
  channelTitle: string;
  views?: string; // display string, e.g. "1.2M"
  age?: string; // display string, e.g. "2mo ago"
  publishedAt?: string; // ISO date, only for the channel-uploads fallback (no display string available)
  duration?: string; // display string, e.g. "13:42"
  thumb: string;
}

const CLIENT = { clientName: "WEB", clientVersion: "2.20260101.00.00", hl: "en", gl: "US" };

/** Walk arbitrary JSON and collect every object that has the given key. */
function* findAll(node: unknown, key: string): Generator<any> {
  if (Array.isArray(node)) for (const n of node) yield* findAll(n, key);
  else if (node && typeof node === "object") {
    if (key in node) yield (node as any)[key];
    for (const v of Object.values(node)) yield* findAll(v, key);
  }
}

export function parseNext(json: unknown): RelatedItem[] {
  const out: RelatedItem[] = [];
  const seen = new Set<string>();
  for (const l of findAll(json, "lockupViewModel")) {
    if (l.contentType !== "LOCKUP_CONTENT_TYPE_VIDEO" || !l.contentId || seen.has(l.contentId)) continue;
    seen.add(l.contentId);
    const meta = l.metadata?.lockupMetadataViewModel;
    const parts: string[] = (meta?.metadata?.contentMetadataViewModel?.metadataRows ?? [])
      .flatMap((r: any) => r.metadataParts ?? [])
      .map((p: any) => p.text?.content)
      .filter(Boolean);
    const overlays = [...findAll(l.contentImage, "text")].filter((t) => typeof t === "string");
    out.push({
      id: l.contentId,
      title: meta?.title?.content ?? "",
      channelTitle: parts[0] ?? "",
      views: parts[1],
      age: parts[2],
      duration: overlays.find((t: string) => /^\d+(:\d\d)+$/.test(t)),
      thumb: `https://i.ytimg.com/vi/${l.contentId}/mqdefault.jpg`,
    });
  }
  return out.filter((i) => i.title);
}

/** YouTube's own "watch next" feed. Unofficial: no key, no quota, may change without notice. */
export function related(id: string): Promise<RelatedItem[]> {
  return cached(`next:${id}`, 60 * 60_000, async () => {
    const res = await fetchT("https://www.youtube.com/youtubei/v1/next", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0 (X11; Linux x86_64) yt-classic" },
      body: JSON.stringify({ videoId: id, context: { client: CLIENT } }),
    });
    if (!res.ok) throw new Error(`next ${id}: ${res.status}`);
    return parseNext(await res.json());
  }, true);
}
