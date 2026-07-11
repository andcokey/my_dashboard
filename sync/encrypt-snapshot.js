// 予定表スナップショットの暗号化ヘルパー（ローカル実行用）。
// Claude(MCP)がOutlookから取得したイベントJSONを暗号化して sync/calendar-snapshot.enc.json に保存する。
// 使い方: SITE_PASSWORD=xxx node sync/encrypt-snapshot.js <入力: 平文イベントJSONパス>
// 入力形式: { fetchedAt: "...", events: [{title,start,end,allDay,location,owner}] }
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptJson } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const password = process.env.SITE_PASSWORD;
const input = process.argv[2];
if (!password || !input) {
  console.error("使い方: SITE_PASSWORD=xxx node sync/encrypt-snapshot.js <events.json>");
  process.exit(1);
}
const data = JSON.parse(await readFile(input, "utf8"));
if (!Array.isArray(data.events)) {
  console.error("入力に events 配列がありません");
  process.exit(1);
}
const out = path.join(__dirname, "calendar-snapshot.enc.json");
await writeFile(out, JSON.stringify(await encryptJson(data, password)));
console.log(`暗号化完了: ${out} (${data.events.length}件, fetchedAt=${data.fetchedAt})`);
