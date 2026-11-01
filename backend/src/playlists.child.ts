// Test helper (run in a child process by playlists.test.ts): adds `count` videos to Watch later and prints the tally.
import { addItem, WATCH_LATER } from "./playlists.ts";

const [offset, count] = process.argv.slice(2).map(Number);
const tally: Record<string, number> = { added: 0, present: 0, full: 0 };
for (let i = 0; i < count; i++) {
  const id = "v" + String(offset + i).padStart(10, "0");
  tally[addItem(WATCH_LATER, { id, title: "t", channelId: "UC" + "a".repeat(22), channelTitle: "c", thumb: "", durationSeconds: 1 }) as string]++;
}
console.log(JSON.stringify(tally));
