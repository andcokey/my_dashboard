// 監視系スナップショットの暗号化ヘルパー（ローカル実行用）。
// Claude(MCP)が取得したデータJSONを暗号化して sync/<domain>-snapshot.enc.json に保存する。
// 使い方: SITE_PASSWORD=xxx node sync/encrypt-snapshot.js <入力JSONパス> [domain]
//   domain省略時は calendar（後方互換）
// domain別の入力形式:
//   calendar: { fetchedAt, events: [{title,start,end,allDay,location,owner,body,joinUrl}] }
//   slack:    { fetchedAt, mentions: [{...}], todosCreated: [{...}] }
//   mail:     { fetchedAt, mailboxes: [...], items: [{...}] }
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encryptJson } from "./crypto.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const password = process.env.SITE_PASSWORD;
const input = process.argv[2];
const domain = process.argv[3] || "calendar";

const REQUIRED_KEY = { calendar: "events", slack: "mentions", mail: "items" };

if (!password || !input || !REQUIRED_KEY[domain]) {
  console.error("使い方: SITE_PASSWORD=xxx node sync/encrypt-snapshot.js <data.json> [calendar|slack|mail]");
  process.exit(1);
}
const data = JSON.parse(await readFile(input, "utf8"));
const key = REQUIRED_KEY[domain];
if (!Array.isArray(data[key])) {
  console.error(`入力に ${key} 配列がありません（domain=${domain}）`);
  process.exit(1);
}
const out = path.join(__dirname, `${domain}-snapshot.enc.json`);
await writeFile(out, JSON.stringify(await encryptJson(data, password)));
console.log(`暗号化完了: ${out} (${data[key].length}件, fetchedAt=${data.fetchedAt})`);
