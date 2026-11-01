// Test helper (run in a child process by store.test.ts): adds `count` subscriptions and prints the result tally.
import { addSub } from "./store.ts";

const [offset, count] = process.argv.slice(2).map(Number);
const tally: Record<string, number> = { added: 0, exists: 0, full: 0 };
for (let i = 0; i < count; i++) tally[await addSub({ id: "UC" + String(offset + i).padStart(22, "0"), title: "t" })]++;
console.log(JSON.stringify(tally));
