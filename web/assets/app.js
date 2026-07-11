// 共通ユーティリティ。data/*.json を読み込み、各ページの一覧・フィルタ・詳細表示を組み立てる。

const NAV_ITEMS = [
  { href: "index.html", label: "トップ" },
  { href: "matters.html", label: "進行中案件" },
  { href: "tasks.html", label: "TODO" },
  { href: "projects.html", label: "プロジェクト" },
  { href: "meetings.html", label: "議事録" },
  { href: "knowledge.html", label: "ナレッジベース" },
];

export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export async function loadJson(name) {
  const res = await fetch(`data/${name}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`data/${name}.json の取得に失敗しました (${res.status})`);
  return res.json();
}

export function fmtDate(dateVal) {
  if (!dateVal) return "";
  if (typeof dateVal === "string") return dateVal;
  if (!dateVal.start) return "";
  return dateVal.end ? `${dateVal.start} 〜 ${dateVal.end}` : dateVal.start;
}

export function statusBadge(status) {
  if (!status) return "";
  return `<span class="badge status-${escapeHtml(status)}">${escapeHtml(status)}</span>`;
}

export function notionLink(url, label = "Notionで開く") {
  if (!url) return "";
  return `<a class="notion-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${label} ↗</a>`;
}

export function renderNav(activeHref) {
  const nav = document.querySelector("nav.app-nav");
  if (!nav) return;
  nav.innerHTML = NAV_ITEMS.map(
    (item) =>
      `<a href="${item.href}" class="${item.href === activeHref ? "active" : ""}">${item.label}</a>`
  ).join("");
}

export async function renderMetaBar() {
  const bar = document.querySelector(".meta-bar");
  if (!bar) return null;
  try {
    const meta = await loadJson("meta");
    const synced = new Date(meta.syncedAt);
    bar.textContent = `最終同期: ${synced.toLocaleString("ja-JP")}（Notionから3時間ごとに自動同期）`;
    return meta;
  } catch (e) {
    bar.textContent = "同期データの読み込みに失敗しました。GitHub Actionsの実行状況を確認してください。";
    console.error(e);
    return null;
  }
}

// rows: オブジェクト配列 / columns: [{key, label, render?(row)=>html}]
export function renderTable(container, rows, columns) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">該当する項目はありません</div>`;
    return;
  }
  const thead = `<tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr>`;
  const tbody = rows
    .map(
      (row) =>
        `<tr>${columns
          .map((c) => `<td>${c.render ? c.render(row) : escapeHtml(row[c.key])}</td>`)
          .join("")}</tr>`
    )
    .join("");
  container.innerHTML = `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

// フィルタ用のselectを作り、変更時にrenderへ絞り込んだ配列を渡す
export function setupStatusFilter(selectEl, rows, statusKey, onChange) {
  const statuses = [...new Set(rows.map((r) => r[statusKey]).filter(Boolean))];
  selectEl.innerHTML =
    `<option value="">すべてのステータス</option>` +
    statuses.map((s) => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
  selectEl.addEventListener("change", () => {
    const v = selectEl.value;
    onChange(v ? rows.filter((r) => r[statusKey] === v) : rows);
  });
}
