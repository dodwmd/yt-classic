import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface Subscription {
  id: string;
  title: string;
}

export const CHANNEL_ID = /^UC[\w-]{22}$/;

const file = () => join(process.env.DATA_DIR ?? "./data", "subscriptions.json");

export async function listSubs(): Promise<Subscription[]> {
  try {
    return JSON.parse(await readFile(file(), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

async function save(subs: Subscription[]): Promise<void> {
  await mkdir(dirname(file()), { recursive: true });
  const tmp = file() + ".tmp";
  await writeFile(tmp, JSON.stringify(subs, null, 2));
  await rename(tmp, file());
}

export async function addSub(sub: Subscription): Promise<void> {
  const subs = await listSubs();
  if (!subs.some((s) => s.id === sub.id)) await save([...subs, sub]);
}

export async function removeSub(id: string): Promise<void> {
  await save((await listSubs()).filter((s) => s.id !== id));
}
