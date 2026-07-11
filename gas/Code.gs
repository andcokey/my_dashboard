/**
 * 板橋ダッシュボード 編集プロキシ（Google Apps Script）
 *
 * ダッシュボード(GitHub Pages)からの編集リクエストを受け取り、Notion APIへ書き込む。
 *
 * ■ セットアップ
 * 1. https://script.google.com で新規プロジェクトを作り、このファイルを貼り付ける
 * 2. 左メニュー「プロジェクトの設定」>「スクリプト プロパティ」に以下を追加:
 *      NOTION_TOKEN  : Notion Integrationのトークン（GitHub Secretsと同じもの）
 *      SHARED_TOKEN  : サイトの合言葉（SITE_PASSWORDと同じ文字列にする）
 * 3. 「デプロイ」>「新しいデプロイ」> 種類「ウェブアプリ」
 *      次のユーザーとして実行: 自分 ／ アクセスできるユーザー: 全員
 * 4. 発行された「ウェブアプリのURL」(https://script.google.com/macros/s/.../exec)
 *    をGitHubリポジトリの Variables（GAS_ENDPOINT）に登録するか、
 *    ダッシュボードの設定画面に貼り付ける
 *
 * ※コードを更新したら「デプロイ」>「デプロイを管理」から既存デプロイを「編集」して
 *   新しいバージョンを発行すること（URLは変わらない）
 */

const PROPS = PropertiesService.getScriptProperties();

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: "リクエストが不正です" });
  }
  if (!body || !body.token || body.token !== PROPS.getProperty("SHARED_TOKEN")) {
    return json_({ ok: false, error: "合言葉が違います" });
  }
  try {
    if (body.action === "update") {
      return json_(updatePage_(body.pageId, body.props || {}));
    }
    if (body.action === "create") {
      return json_(createPage_(body.databaseId, body.props || {}));
    }
    if (body.action === "archive") {
      return json_(archivePage_(body.pageId));
    }
    return json_({ ok: false, error: "不明なaction: " + body.action + "（GASのコードが古い可能性があります。gas/Code.gsを貼り直して新バージョンをデプロイしてください）" });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}

function doGet() {
  return json_({ ok: true, service: "dashboard-edit-proxy" });
}

function notionFetch_(path, method, payload) {
  const res = UrlFetchApp.fetch("https://api.notion.com/v1/" + path, {
    method: method,
    contentType: "application/json",
    headers: {
      Authorization: "Bearer " + PROPS.getProperty("NOTION_TOKEN"),
      "Notion-Version": "2022-06-28",
    },
    payload: payload ? JSON.stringify(payload) : undefined,
    muteHttpExceptions: true,
  });
  const data = JSON.parse(res.getContentText());
  if (res.getResponseCode() >= 300) {
    throw new Error(data.message || "Notion APIエラー (" + res.getResponseCode() + ")");
  }
  return data;
}

// スキーマのプロパティ型に合わせてNotionの更新ペイロードを組み立てる
function buildProps_(schemaProps, updates) {
  const out = {};
  Object.keys(updates).forEach(function (key) {
    if (!schemaProps[key]) return;
    const type = schemaProps[key].type;
    const value = updates[key];
    const empty = value === null || value === undefined || value === "";
    if (type === "title") {
      out[key] = { title: empty ? [] : [{ text: { content: String(value) } }] };
    } else if (type === "rich_text") {
      out[key] = { rich_text: empty ? [] : [{ text: { content: String(value) } }] };
    } else if (type === "status") {
      out[key] = { status: empty ? null : { name: String(value) } };
    } else if (type === "select") {
      out[key] = { select: empty ? null : { name: String(value) } };
    } else if (type === "multi_select") {
      out[key] = {
        multi_select: empty ? [] : String(value).split(",").map(function (v) { return { name: v.trim() }; }),
      };
    } else if (type === "date") {
      out[key] = { date: empty ? null : { start: String(value) } };
    } else if (type === "number") {
      out[key] = { number: empty ? null : Number(value) };
    } else if (type === "checkbox") {
      out[key] = { checkbox: !!value };
    } else if (type === "relation") {
      const ids = Array.isArray(value) ? value : empty ? [] : [value];
      out[key] = { relation: ids.map(function (id) { return { id: id }; }) };
    }
  });
  return out;
}

function updatePage_(pageId, updates) {
  if (!pageId) throw new Error("pageIdがありません");
  const page = notionFetch_("pages/" + pageId, "get");
  const props = buildProps_(page.properties, updates);
  if (!Object.keys(props).length) throw new Error("更新できる項目がありません");
  notionFetch_("pages/" + pageId, "patch", { properties: props });
  return { ok: true };
}

function createPage_(databaseId, updates) {
  if (!databaseId) throw new Error("databaseIdがありません");
  const db = notionFetch_("databases/" + databaseId, "get");
  const props = buildProps_(db.properties, updates);
  const page = notionFetch_("pages", "post", {
    parent: { database_id: databaseId },
    properties: props,
  });
  return { ok: true, id: page.id, url: page.url };
}

// ページをNotionのゴミ箱に移動する（Notion側で30日以内なら復元可能）
function archivePage_(pageId) {
  if (!pageId) throw new Error("pageIdがありません");
  notionFetch_("pages/" + pageId, "patch", { archived: true });
  return { ok: true };
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}
