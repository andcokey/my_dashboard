// Notionから基幹5データソースを取得し、web/data/*.json として書き出す。
// 読み取り専用ビューア用のスナップショット生成スクリプト（GitHub Actionsから定期実行 / ローカルでも手動実行可）。
import { Client } from "@notionhq/client";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "web", "data");

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  console.error("環境変数 NOTION_TOKEN が設定されていません。");
  process.exit(1);
}

const notion = new Client({ auth: NOTION_TOKEN });

// 対象データソース（Notion側で名称・IDが変わった場合はここを更新する）
const SOURCES = {
  matters: "142608b7-14a5-44eb-9c73-d936c8ee6c69", // 📁 進行中案件
  tasks: "39b5bc43-8f77-4ef4-8ae5-f196cd455d4c", // ✅ TODO
  projects: "d8f104c2-3dac-4122-acb4-1290aa353942", // プロジェクト管理
  meetings: "c7b42ace-626f-4ffd-ac88-1576c14a87a0", // 議事録
};
const KNOWLEDGE_PAGE_ID = "3422d2f5-d959-810d-9650-d1748eb66e3b"; // 📚 ナレッジベース
const DASHBOARD_ROOT_PAGE_ID = "3422d2f5-d959-81c5-9d39-dd2de481fec1"; // 板橋 ダッシュボード

function richTextToPlain(richText) {
  if (!richText || !Array.isArray(richText)) return "";
  return richText.map((t) => t.plain_text).join("");
}

function extractProp(prop) {
  if (!prop) return null;
  switch (prop.type) {
    case "title":
      return richTextToPlain(prop.title);
    case "rich_text":
      return richTextToPlain(prop.rich_text);
    case "select":
      return prop.select?.name ?? null;
    case "status":
      return prop.status?.name ?? null;
    case "multi_select":
      return prop.multi_select.map((o) => o.name);
    case "date":
      return prop.date ? { start: prop.date.start, end: prop.date.end } : null;
    case "people":
      return prop.people.map((p) => p.name || p.id);
    case "relation":
      return prop.relation.map((r) => r.id);
    case "unique_id":
      return prop.unique_id
        ? `${prop.unique_id.prefix ?? ""}${prop.unique_id.number}`
        : null;
    case "number":
      return prop.number;
    case "checkbox":
      return prop.checkbox;
    case "url":
      return prop.url;
    default:
      return null;
  }
}

function pagePropsToObject(page) {
  const out = { id: page.id, url: page.url };
  for (const [key, prop] of Object.entries(page.properties)) {
    out[key] = extractProp(prop);
  }
  return out;
}

async function queryAll(databaseId) {
  const results = [];
  let cursor = undefined;
  do {
    const res = await notion.databases.query({
      database_id: databaseId,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ブロックを簡易Markdown行に変換する（子ブロックはfetchPageBody側でインデント付きで展開）
function blockToLine(block) {
  const t = block.type;
  const rt = block[t]?.rich_text;
  const text = rt ? richTextToPlain(rt) : "";
  switch (t) {
    case "paragraph":
      return text;
    case "heading_1":
      return `# ${text}`;
    case "heading_2":
      return `## ${text}`;
    case "heading_3":
      return `### ${text}`;
    case "bulleted_list_item":
      return `- ${text}`;
    case "numbered_list_item":
      return `- ${text}`;
    case "quote":
      return `> ${text}`;
    case "callout":
      return `${block.callout?.icon?.emoji ?? "💡"} ${text}`;
    case "to_do":
      return `${block.to_do?.checked ? "[x]" : "[ ]"} ${text}`;
    case "code":
      return `\`\`\`\n${text}\n\`\`\``;
    case "toggle":
      return `- ${text}`;
    case "divider":
      return "---";
    case "child_page":
      return `📄 ${block.child_page?.title ?? "(無題ページ)"}`;
    case "child_database":
      return null; // インラインDBは別途データソースとして扱う
    default:
      return null;
  }
}

async function listAllChildren(blockId) {
  const results = [];
  let cursor = undefined;
  do {
    const res = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    results.push(...res.results);
    cursor = res.has_more ? res.next_cursor : undefined;
  } while (cursor);
  return results;
}

// ページ本文をMarkdown化。ネストしたブロック（トグル・リスト配下）はdepth=2までインデント付きで展開。
async function fetchPageBody(pageId, depth = 0, maxDepth = 2) {
  const blocks = await listAllChildren(pageId);
  const lines = [];
  const childPages = [];
  for (const block of blocks) {
    if (block.type === "child_page") {
      childPages.push({
        id: block.id,
        title: block.child_page?.title ?? "(無題ページ)",
        url: `https://www.notion.so/${block.id.replace(/-/g, "")}`,
      });
      if (depth > 0) continue;
    }
    const line = blockToLine(block);
    if (line !== null && !(line === "" && depth > 0)) {
      lines.push("  ".repeat(depth) + line);
    }
    if (
      block.has_children &&
      depth < maxDepth &&
      block.type !== "child_page" &&
      block.type !== "child_database"
    ) {
      const child = await fetchPageBody(block.id, depth + 1, maxDepth);
      if (child.markdown) lines.push(child.markdown);
    }
  }
  return { markdown: lines.join("\n"), childPages };
}

// ページ配列それぞれの本文を取得して body プロパティとして付与する
async function attachBodies(pages, label) {
  let i = 0;
  for (const page of pages) {
    i += 1;
    const body = await fetchPageBody(page.id);
    page.body = body.markdown;
  }
  console.log(`  ${label}: ${i}件の本文を取得`);
  return pages;
}

// ダッシュボード先頭の「今週のフォーカス」セクション（最初のdividerまで）を抜き出す
async function fetchWeeklyFocus(pageId) {
  const res = await notion.blocks.children.list({
    block_id: pageId,
    page_size: 20,
  });
  const lines = [];
  for (const block of res.results) {
    if (block.type === "divider") break;
    const line = blockToLine(block);
    if (line !== null) lines.push(line);
  }
  return lines.join("\n");
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  console.log("プロジェクト管理を取得中...");
  const projectPages = await queryAll(SOURCES.projects);
  const projects = projectPages.map(pagePropsToObject);
  const projectNameById = new Map(
    projects.map((p) => [p.id, p["プロジェクト名"]])
  );

  function resolveProjectRelation(ids) {
    if (!Array.isArray(ids)) return [];
    return ids.map((id) => ({ id, name: projectNameById.get(id) ?? null }));
  }

  console.log("進行中案件を取得中...");
  const matters = (await queryAll(SOURCES.matters)).map(pagePropsToObject);
  await attachBodies(matters, "進行中案件");

  console.log("TODOを取得中...");
  const tasks = (await queryAll(SOURCES.tasks)).map((page) => {
    const obj = pagePropsToObject(page);
    obj["プロジェクト"] = resolveProjectRelation(obj["プロジェクト"]);
    return obj;
  });
  await attachBodies(tasks, "TODO");

  await attachBodies(projects, "プロジェクト");

  console.log("議事録を取得中...");
  const meetingPages = await queryAll(SOURCES.meetings);
  const meetings = [];
  for (const page of meetingPages) {
    const obj = pagePropsToObject(page);
    obj["プロジェクト"] = resolveProjectRelation(obj["プロジェクト"]);
    meetings.push(obj);
  }
  await attachBodies(meetings, "議事録");

  console.log("ナレッジベースを取得中...");
  const kbBody = await fetchPageBody(KNOWLEDGE_PAGE_ID);
  const articles = [];
  for (const child of kbBody.childPages) {
    const childBody = await fetchPageBody(child.id);
    articles.push({ ...child, body: childBody.markdown });
  }
  const knowledge = {
    body: kbBody.markdown,
    articles,
  };

  console.log("今週のフォーカスを取得中...");
  const weeklyFocus = await fetchWeeklyFocus(DASHBOARD_ROOT_PAGE_ID);

  const meta = {
    syncedAt: new Date().toISOString(),
    weeklyFocus,
    dashboardUrl: `https://www.notion.so/${DASHBOARD_ROOT_PAGE_ID.replace(
      /-/g,
      ""
    )}`,
  };

  await writeFile(
    path.join(OUT_DIR, "matters.json"),
    JSON.stringify(matters, null, 2)
  );
  await writeFile(
    path.join(OUT_DIR, "tasks.json"),
    JSON.stringify(tasks, null, 2)
  );
  await writeFile(
    path.join(OUT_DIR, "projects.json"),
    JSON.stringify(projects, null, 2)
  );
  await writeFile(
    path.join(OUT_DIR, "meetings.json"),
    JSON.stringify(meetings, null, 2)
  );
  await writeFile(
    path.join(OUT_DIR, "knowledge.json"),
    JSON.stringify(knowledge, null, 2)
  );
  await writeFile(path.join(OUT_DIR, "meta.json"), JSON.stringify(meta, null, 2));

  console.log(
    `完了: matters=${matters.length} tasks=${tasks.length} projects=${projects.length} meetings=${meetings.length}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
