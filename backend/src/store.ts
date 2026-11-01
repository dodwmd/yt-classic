import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Subscription {
  id: string;
  title: string;
}

export const CHANNEL_ID = /^UC[\w-]{22}$/;
export const MAX_SUBS = 500;

const file = () => join(process.env.DATA_DIR ?? "./data", "subscriptions.json");

const isSub = (s: unknown): s is Subscription =>
  !!s && typeof s === "object" && typeof (s as Subscription).id === "string" && typeof (s as Subscription).title === "string";

export async function listSubs(): Promise<Subscription[]> {
  let raw: string;
  try {
    raw = await readFile(file(), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every(isSub)) return parsed;
    throw new Error("not an array of {id, title}");
  } catch (e) {
    // Don't take the whole site down over a damaged file: keep a copy for inspection and start empty.
    const bak = `${file()}.corrupt-${Date.now()}`;
    console.error(`subscriptions.json is unreadable (${(e as Error).message}); moved to ${bak}`);
    await rename(file(), bak).catch(() => {});
    return [];
  }
}

// All writers go through one queue so read-modify-write cycles can't interleave.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

let tmpCounter = 0;
async function save(subs: Subscription[]): Promise<void> {
  await mkdir(dirname(file()), { recursive: true });
  const tmp = `${file()}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, JSON.stringify(subs, null, 2));
  await rename(tmp, file());
}

export function addSub(sub: Subscription): Promise<"added" | "exists" | "full"> {
  return serialize(async () => {
    const subs = await listSubs();
    if (subs.some((s) => s.id === sub.id)) return "exists";
    if (subs.length >= MAX_SUBS) return "full";
    await save([...subs, sub]);
    return "added";
  });
}

export function removeSub(id: string): Promise<void> {
  return serialize(async () => save((await listSubs()).filter((s) => s.id !== id)));
}
