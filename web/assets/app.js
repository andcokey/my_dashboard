// 板橋ダッシュボード SPA本体。data/*.json を読み込み、タブ・KPI・チャート・一覧・詳細ドロワーを組み立てる。

const TABS = [
  { id: "overview", label: "概要" },
  { id: "matters", label: "進行中案件" },
  { id: "tasks", label: "TODO" },
  { id: "projects", label: "プロジェクト" },
  { id: "meetings", label: "議事録" },
  { id: "knowledge", label: "ナレッジ" },
];

const state = { data: null };

/* ---------------- ユーティリティ ---------------- */

function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function loadJson(name) {
  const res = await fetch(`data/${name}.json`, { cache: "no-store" });
  if (!res.ok) throw new Error(`data/${name}.json の取得に失敗しました (${res.status})`);
  return res.json();
}

function dateStart(dateVal) {
  if (!dateVal) return null;
  if (typeof dateVal === "string") return dateVal.slice(0, 10);
  return dateVal.start ? dateVal.start.slice(0, 10) : null;
}

function fmtDate(dateVal) {
  if (!dateVal) return "";
  if (typeof dateVal === "string") return dateVal;
  if (!dateVal.start) return "";
  return dateVal.end ? `${dateVal.start} 〜 ${dateVal.end}` : dateVal.start;
}

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function daysUntil(dateVal) {
  const s = dateStart(dateVal);
  if (!s) return null;
  const ms = new Date(s + "T00:00:00") - new Date(todayStr() + "T00:00:00");
  return Math.round(ms / 86400000);
}

const DONE_STATUSES = new Set(["完了", "見送り", "クローズ"]);
function isDone(row) {
  return DONE_STATUSES.has(row["ステータス"]);
}

function statusClass(status) {
  if (!status) return "";
  if (/完了/.test(status)) return "st-done";
  if (/進行|対応|着手/.test(status)) return "st-active";
  if (/レビュー/.test(status)) return "st-review";
  if (/見送り|保留|未着手|準備/.test(status)) return "st-hold";
  return "";
}

function statusBadge(status) {
  if (!status) return `<span class="badge st-hold">未設定</span>`;
  return `<span class="badge ${statusClass(status)}">${escapeHtml(status)}</span>`;
}

function priNumber(pri) {
  if (pri === null || pri === undefined || pri === "") return null;
  const map = { 高: 1, 中: 2, 低: 3, "🔴高": 1, "🟡中": 2, "🟢低": 3 };
  if (map[pri]) return map[pri];
  const n = parseInt(pri, 10);
  return Number.isNaN(n) ? null : n;
}

function priBadge(pri) {
  const n = priNumber(pri);
  if (n === null) return "";
  const cls = n <= 1 ? "pri-1" : n === 2 ? "pri-2" : "pri-3";
  return `<span class="badge ${cls}">P${n}</span>`;
}

function dueCell(row) {
  const s = dateStart(row["期日"] ?? row["日時"]);
  if (!s) return "";
  if (isDone(row)) return escapeHtml(s);
  const d = daysUntil(row["期日"] ?? row["日時"]);
  if (d < 0) return `<span class="due-over">${escapeHtml(s)} (${-d}日超過)</span>`;
  if (d <= 3) return `<span class="due-soon">${escapeHtml(s)} (あと${d}日)</span>`;
  return escapeHtml(s);
}

function peopleText(v) {
  return Array.isArray(v) ? v.join(", ") : (v ?? "");
}

function projectNames(row) {
  const rel = row["プロジェクト"];
  if (!Array.isArray(rel)) return "";
  return rel.map((r) => (typeof r === "object" ? r.name : r)).filter(Boolean).join(", ");
}

/* ---------------- 簡易Markdown描画 ----------------
   sync/fetch-notion.js が出力する行指向Markdownを前提にした最小レンダラ。 */
function renderMarkdown(md) {
  if (!md || !md.trim()) return `<p class="md-empty">（本文はありません）</p>`;
  const lines = md.split("\n");
  const out = [];
  let listStack = 0; // 現在開いている <ul> の深さ
  let inCode = false;
  const closeLists = (to = 0) => {
    while (listStack > to) {
      out.push("</ul>");
      listStack -= 1;
    }
  };
  for (const raw of lines) {
    if (raw.trim() === "```") {
      closeLists();
      out.push(inCode ? "</pre>" : "<pre>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(raw) + "\n");
      continue;
    }
    const indent = Math.floor((raw.match(/^ */)[0].length) / 2);
    const line = raw.trim();
    if (!line) { continue; }
    const m = line.match(/^(#{1,3}) (.*)$/);
    if (m) {
      closeLists();
      const level = m[1].length;
      out.push(`<h${level}>${escapeHtml(m[2])}</h${level}>`);
      continue;
    }
    if (line === "---") {
      closeLists();
      out.push("<hr>");
      continue;
    }
    if (line.startsWith("- ") || line.startsWith("[x] ") || line.startsWith("[ ] ")) {
      const want = indent + 1;
      closeLists(want);
      while (listStack < want) {
        out.push("<ul>");
        listStack += 1;
      }
      if (line.startsWith("[x] ")) {
        out.push(`<li class="todo-done">☑ ${escapeHtml(line.slice(4))}</li>`);
      } else if (line.startsWith("[ ] ")) {
        out.push(`<li>☐ ${escapeHtml(line.slice(4))}</li>`);
      } else {
        out.push(`<li>${escapeHtml(line.slice(2))}</li>`);
      }
      continue;
    }
    if (line.startsWith("> ")) {
      closeLists();
      out.push(`<blockquote>${escapeHtml(line.slice(2))}</blockquote>`);
      continue;
    }
    closeLists();
    out.push(`<p>${escapeHtml(line)}</p>`);
  }
  closeLists();
  if (inCode) out.push("</pre>");
  return `<div class="md">${out.join("")}</div>`;
}

/* ---------------- チャート ---------------- */

let tooltipEl = null;
function tooltip() {
  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.className = "viz-tooltip";
    document.body.appendChild(tooltipEl);
  }
  return tooltipEl;
}
function bindTooltip(svg) {
  svg.querySelectorAll("[data-tip]").forEach((el) => {
    el.addEventListener("pointermove", (e) => {
      const t = tooltip();
      t.textContent = el.dataset.tip;
      t.style.display = "block";
      t.style.left = `${e.clientX + 12}px`;
      t.style.top = `${e.clientY - 30}px`;
    });
    el.addEventListener("pointerleave", () => {
      tooltip().style.display = "none";
    });
  });
}

// 横1本の積み上げバー（構成比）。segments: [{label, value, color}]
function stackedBarH(container, segments, { showLegend = true } = {}) {
  const total = segments.reduce((s, x) => s + x.value, 0);
  if (!total) {
    container.innerHTML = `<div class="empty-state">データがありません</div>`;
    return;
  }
  const W = 600, H = 34, GAP = 2;
  let x = 0;
  const rects = [];
  const labels = [];
  for (const seg of segments) {
    if (!seg.value) continue;
    const w = (seg.value / total) * (W - GAP * (segments.filter(s => s.value).length - 1));
    rects.push(
      `<rect x="${x}" y="6" width="${Math.max(w, 2)}" height="20" rx="4" fill="${seg.color}" data-tip="${escapeHtml(seg.label)}: ${seg.value}件 (${Math.round((seg.value / total) * 100)}%)"></rect>`
    );
    if (w > 40) {
      labels.push(
        `<text x="${x + w / 2}" y="20" text-anchor="middle" font-size="11" font-weight="600" fill="${seg.textOnMark || "#ffffff"}">${seg.value}</text>`
      );
    }
    x += w + GAP;
  }
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="構成比バー">${rects.join("")}${labels.join("")}</svg>
    ${showLegend ? `<div class="chart-legend">${segments.map((s) => `<span class="key"><span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)} ${s.value}件</span>`).join("")}</div>` : ""}`;
  bindTooltip(container.querySelector("svg"));
}

// 縦棒チャート（単一系列）。items: [{label, value, tip}]
function columnChart(container, items, { unit = "" } = {}) {
  if (!items.length || items.every((i) => !i.value)) {
    container.innerHTML = `<div class="empty-state">データがありません</div>`;
    return;
  }
  const W = 600, H = 170, PAD_L = 26, PAD_B = 22, PAD_T = 10;
  const max = Math.max(...items.map((i) => i.value), 1);
  const innerW = W - PAD_L - 6;
  const innerH = H - PAD_T - PAD_B;
  const bw = Math.min(34, (innerW / items.length) - 2);
  const gridLines = [];
  const steps = Math.min(max, 4);
  for (let i = 1; i <= steps; i++) {
    const v = Math.round((max / steps) * i);
    const y = PAD_T + innerH - (v / max) * innerH;
    gridLines.push(
      `<line x1="${PAD_L}" y1="${y}" x2="${W - 4}" y2="${y}" stroke="var(--grid)" stroke-width="1"></line>
       <text x="${PAD_L - 5}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${v}</text>`
    );
  }
  const bars = items.map((item, i) => {
    const cx = PAD_L + (innerW / items.length) * (i + 0.5);
    const h = item.value ? Math.max((item.value / max) * innerH, 3) : 0;
    const y = PAD_T + innerH - h;
    const labelEvery = Math.ceil(items.length / 8);
    const tick = i % labelEvery === 0
      ? `<text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${escapeHtml(item.label)}</text>`
      : "";
    const bar = item.value
      ? `<rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${h}" rx="4" fill="var(--series-1)" data-tip="${escapeHtml(item.tip || `${item.label}: ${item.value}${unit}`)}"></rect>`
      : "";
    return `${bar}${tick}`;
  });
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="棒グラフ">
      ${gridLines.join("")}
      <line x1="${PAD_L}" y1="${PAD_T + innerH}" x2="${W - 4}" y2="${PAD_T + innerH}" stroke="var(--baseline)" stroke-width="1"></line>
      ${bars.join("")}
    </svg>`;
  bindTooltip(container.querySelector("svg"));
}

// プロジェクト別 横積み上げバー。rows: [{name, open, done}]
function projectBars(container, rows) {
  const visible = rows.filter((r) => r.open + r.done > 0);
  if (!visible.length) {
    container.innerHTML = `<div class="empty-state">タスクが紐づくプロジェクトはまだありません</div>`;
    return;
  }
  const max = Math.max(...visible.map((r) => r.open + r.done));
  const W = 600, ROW_H = 30, LABEL_W = 110, GAP = 2;
  const innerW = W - LABEL_W - 60;
  const H = visible.length * ROW_H + 4;
  const parts = visible.map((r, i) => {
    const y = i * ROW_H + 6;
    const openW = (r.open / max) * innerW;
    const doneW = (r.done / max) * innerW;
    let x = LABEL_W;
    let bars = "";
    if (r.open) {
      bars += `<rect x="${x}" y="${y}" width="${Math.max(openW, 2)}" height="18" rx="4" fill="var(--series-1)" data-tip="${escapeHtml(r.name)} 未完了: ${r.open}件"></rect>`;
      x += Math.max(openW, 2) + GAP;
    }
    if (r.done) {
      bars += `<rect x="${x}" y="${y}" width="${Math.max(doneW, 2)}" height="18" rx="4" fill="var(--gray-mark)" data-tip="${escapeHtml(r.name)} 完了: ${r.done}件"></rect>`;
      x += Math.max(doneW, 2) + GAP;
    }
    return `
      <text x="${LABEL_W - 8}" y="${y + 13}" text-anchor="end" font-size="11" fill="var(--ink-2)">${escapeHtml(r.name)}</text>
      ${bars}
      <text x="${x + 6}" y="${y + 13}" font-size="11" fill="var(--muted)">${r.open}/${r.open + r.done}</text>`;
  });
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="プロジェクト別タスク">${parts.join("")}</svg>
    <div class="chart-legend">
      <span class="key"><span class="swatch" style="background:var(--series-1)"></span>未完了</span>
      <span class="key"><span class="swatch" style="background:var(--gray-mark)"></span>完了・見送り</span>
      <span class="key" style="color:var(--muted)">数字は 未完了/全体</span>
    </div>`;
  bindTooltip(container.querySelector("svg"));
}

/* ---------------- 詳細ドロワー ---------------- */

function notionLink(url, label = "Notionで開く") {
  if (!url) return "";
  return `<a class="notion-link" href="${escapeHtml(url)}" target="_blank" rel="noopener">${label} ↗</a>`;
}

function openDrawer(title, propsHtml, bodyMd, url, extraHtml = "") {
  document.getElementById("drawer-title").textContent = title;
  const bodyHtml =
    bodyMd === undefined
      ? `<p class="md-empty">本文は次回のNotion同期後に表示されます。${notionLink(url)}</p>`
      : renderMarkdown(bodyMd);
  document.getElementById("drawer-content").innerHTML = `
    ${propsHtml}
    ${url ? `<p>${notionLink(url)}</p>` : ""}
    <hr class="drawer-divider">
    ${bodyHtml}
    ${extraHtml}`;
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawer-backdrop").classList.add("open");
}

function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("drawer-backdrop").classList.remove("open");
}

function propGrid(pairs) {
  const rows = pairs
    .filter(([, v]) => v !== "" && v !== null && v !== undefined)
    .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${v}</dd>`);
  return rows.length ? `<dl class="prop-grid">${rows.join("")}</dl>` : "";
}

function openTaskDetail(t) {
  openDrawer(t["タスク名"] || "(無題)", propGrid([
    ["ID", escapeHtml(t["ID"])],
    ["ステータス", statusBadge(t["ステータス"])],
    ["優先度", priBadge(t["優先度"])],
    ["期日", dueCell(t)],
    ["担当者", escapeHtml(peopleText(t["担当者"]))],
    ["プロジェクト", escapeHtml(projectNames(t))],
    ["メモ", escapeHtml(t["メモ"])],
  ]), t.body, t.url);
}

function openMatterDetail(m) {
  openDrawer(m["案件名"] || "(無題)", propGrid([
    ["ステータス", statusBadge(m["ステータス"])],
    ["優先度", priBadge(m["優先度"])],
    ["期日", dueCell(m)],
    ["担当者", escapeHtml(peopleText(m["担当者"]))],
    ["ラベル", escapeHtml(peopleText(m["ラベル"]))],
    ["メモ", escapeHtml(m["メモ"])],
  ]), m.body, m.url);
}

function openProjectDetail(p) {
  const tasks = state.data.tasks.filter((t) =>
    (t["プロジェクト"] || []).some((r) => r.id === p.id)
  );
  const open = tasks.filter((t) => !isDone(t));
  const taskList = tasks.length
    ? `<h3 style="font-size:13px;margin:16px 0 6px;">関連タスク（未完了 ${open.length} / 全 ${tasks.length}）</h3>
       <ul style="padding-left:18px;font-size:13px;">${tasks
         .map((t) => `<li>${isDone(t) ? "☑" : "☐"} ${escapeHtml(t["タスク名"])} ${statusBadge(t["ステータス"])}</li>`)
         .join("")}</ul>`
    : "";
  openDrawer(p["プロジェクト名"] || "(無題)", propGrid([
    ["ID", escapeHtml(p["ID"])],
    ["ステータス", statusBadge(p["ステータス"])],
    ["優先度", priBadge(p["優先度"])],
    ["開始日", escapeHtml(fmtDate(p["開始日"]))],
    ["期日", escapeHtml(fmtDate(p["期日"]))],
    ["担当者", escapeHtml(peopleText(p["担当者"]))],
    ["概要", escapeHtml(p["概要"])],
  ]), p.body, p.url, taskList);
}

function openMeetingDetail(m) {
  openDrawer(m["会議名"] || "(無題)", propGrid([
    ["ID", escapeHtml(m["ID"])],
    ["日時", escapeHtml(fmtDate(m["日時"]))],
    ["会議種別", escapeHtml(m["会議種別"])],
    ["ステータス", statusBadge(m["ステータス"])],
    ["参加者", escapeHtml(peopleText(m["参加者"]))],
    ["プロジェクト", escapeHtml(projectNames(m))],
  ]), m.body, m.url);
}

/* ---------------- テーブル ---------------- */

function renderTable(container, rows, columns, onRowClick) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">該当する項目はありません</div>`;
    return;
  }
  const thead = `<tr>${columns.map((c) => `<th>${escapeHtml(c.label)}</th>`).join("")}</tr>`;
  const tbody = rows
    .map(
      (row, i) =>
        `<tr class="row-click" data-i="${i}">${columns
          .map((c) => `<td class="${c.cls || ""}">${c.render ? c.render(row) : escapeHtml(row[c.key])}</td>`)
          .join("")}</tr>`
    )
    .join("");
  container.innerHTML = `<div class="table-wrap"><table><thead>${thead}</thead><tbody>${tbody}</tbody></table></div>`;
  container.querySelectorAll("tr.row-click").forEach((tr) => {
    tr.addEventListener("click", () => onRowClick(rows[Number(tr.dataset.i)]));
  });
}

// フィルタ行（検索 + 任意のselect群）を組み立てて、変更のたびに onChange(絞り込み結果) を呼ぶ
function setupFilters(container, rows, selects, searchKeys, onChange) {
  const selEls = selects.map((s) => {
    const values = [...new Set(rows.map(s.get).flat().filter(Boolean))];
    const el = document.createElement("select");
    el.innerHTML =
      `<option value="">${escapeHtml(s.allLabel)}</option>` +
      values.map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
    return { el, spec: s };
  });
  const search = document.createElement("input");
  search.type = "search";
  search.placeholder = "キーワード検索…";
  const apply = () => {
    let filtered = rows;
    for (const { el, spec } of selEls) {
      if (el.value) {
        filtered = filtered.filter((r) => {
          const v = spec.get(r);
          return Array.isArray(v) ? v.includes(el.value) : v === el.value;
        });
      }
    }
    const q = search.value.trim().toLowerCase();
    if (q) {
      filtered = filtered.filter((r) =>
        searchKeys.some((k) => {
          const v = typeof k === "function" ? k(r) : r[k];
          return v && String(v).toLowerCase().includes(q);
        })
      );
    }
    onChange(filtered);
  };
  container.innerHTML = "";
  container.append(search, ...selEls.map((s) => s.el));
  selEls.forEach(({ el }) => el.addEventListener("change", apply));
  search.addEventListener("input", apply);
}

/* ---------------- 各タブ ---------------- */

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const doneDiff = Number(isDone(a)) - Number(isDone(b));
    if (doneDiff) return doneDiff;
    const da = dateStart(a["期日"]), db = dateStart(b["期日"]);
    if (da && db) return isDone(a) ? db.localeCompare(da) : da.localeCompare(db);
    if (da) return -1;
    if (db) return 1;
    return (priNumber(a["優先度"]) ?? 9) - (priNumber(b["優先度"]) ?? 9);
  });
}

const TASK_COLUMNS = [
  { label: "タスク", render: (t) => `<span class="row-title">${escapeHtml(t["タスク名"])}</span>` },
  { label: "ステータス", render: (t) => statusBadge(t["ステータス"]) },
  { label: "優先度", render: (t) => priBadge(t["優先度"]) },
  { label: "期日", cls: "num", render: (t) => dueCell(t) },
  { label: "プロジェクト", render: (t) => escapeHtml(projectNames(t)) },
];

function renderTasksTab() {
  const tasks = sortTasks(state.data.tasks);
  const tableEl = document.getElementById("tasks-table");
  setupFilters(
    document.getElementById("tasks-filter"),
    tasks,
    [
      { allLabel: "すべてのステータス", get: (t) => t["ステータス"] },
      { allLabel: "すべてのプロジェクト", get: (t) => (t["プロジェクト"] || []).map((r) => r.name).filter(Boolean) },
    ],
    ["タスク名", "メモ", (t) => t.body],
    (rows) => renderTable(tableEl, rows, TASK_COLUMNS, openTaskDetail)
  );
  renderTable(tableEl, tasks, TASK_COLUMNS, openTaskDetail);
}

function renderMattersTab() {
  const matters = state.data.matters;
  const columns = [
    { label: "案件名", render: (m) => `<span class="row-title">${escapeHtml(m["案件名"])}</span>` },
    { label: "ステータス", render: (m) => statusBadge(m["ステータス"]) },
    { label: "優先度", render: (m) => priBadge(m["優先度"]) },
    { label: "期日", cls: "num", render: (m) => dueCell(m) },
    { label: "ラベル", render: (m) => escapeHtml(peopleText(m["ラベル"])) },
    { label: "メモ", render: (m) => escapeHtml(m["メモ"]) },
  ];
  const tableEl = document.getElementById("matters-table");
  setupFilters(
    document.getElementById("matters-filter"),
    matters,
    [{ allLabel: "すべてのステータス", get: (m) => m["ステータス"] }],
    ["案件名", "メモ", (m) => m.body],
    (rows) => renderTable(tableEl, rows, columns, openMatterDetail)
  );
  renderTable(tableEl, matters, columns, openMatterDetail);
}

function projectTaskStats(p) {
  const tasks = state.data.tasks.filter((t) =>
    (t["プロジェクト"] || []).some((r) => r.id === p.id)
  );
  const open = tasks.filter((t) => !isDone(t)).length;
  return { total: tasks.length, open, done: tasks.length - open };
}

function renderProjectsTab() {
  const projects = state.data.projects;
  const columns = [
    { label: "プロジェクト", render: (p) => `<span class="row-title">${escapeHtml(p["プロジェクト名"])}</span>` },
    { label: "ステータス", render: (p) => statusBadge(p["ステータス"]) },
    {
      label: "タスク消化",
      render: (p) => {
        const s = projectTaskStats(p);
        if (!s.total) return `<span style="color:var(--muted)">—</span>`;
        const pct = Math.round((s.done / s.total) * 100);
        return `<div style="display:flex;align-items:center;gap:8px;">
          <div class="meter" style="flex:1;max-width:140px;"><span style="width:${pct}%"></span></div>
          <span class="num" style="font-size:12px;color:var(--ink-2);white-space:nowrap;">${s.done}/${s.total} (${pct}%)</span>
        </div>`;
      },
    },
    { label: "期間", cls: "num", render: (p) => escapeHtml([fmtDate(p["開始日"]), fmtDate(p["期日"])].filter(Boolean).join(" → ")) },
    { label: "概要", render: (p) => escapeHtml(p["概要"]) },
  ];
  renderTable(document.getElementById("projects-table"), projects, columns, openProjectDetail);
}

function sortMeetings(meetings) {
  return [...meetings].sort((a, b) =>
    (dateStart(b["日時"]) || "").localeCompare(dateStart(a["日時"]) || "")
  );
}

function renderMeetingsTab() {
  const meetings = sortMeetings(state.data.meetings);
  const columns = [
    { label: "日時", cls: "num", render: (m) => escapeHtml(fmtDate(m["日時"])) },
    { label: "会議名", render: (m) => `<span class="row-title">${escapeHtml(m["会議名"])}</span>` },
    { label: "種別", render: (m) => m["会議種別"] ? `<span class="badge">${escapeHtml(m["会議種別"])}</span>` : "" },
    { label: "参加者", render: (m) => escapeHtml(peopleText(m["参加者"])) },
    { label: "プロジェクト", render: (m) => escapeHtml(projectNames(m)) },
  ];
  const tableEl = document.getElementById("meetings-table");
  setupFilters(
    document.getElementById("meetings-filter"),
    meetings,
    [{ allLabel: "すべての種別", get: (m) => m["会議種別"] }],
    ["会議名", (m) => m.body],
    (rows) => renderTable(tableEl, rows, columns, openMeetingDetail)
  );
  renderTable(tableEl, meetings, columns, openMeetingDetail);
}

function renderKnowledgeTab() {
  const kb = state.data.knowledge;
  document.getElementById("kb-body").innerHTML = renderMarkdown(kb.body);
  const articlesEl = document.getElementById("kb-articles");
  if (!kb.articles?.length) {
    articlesEl.innerHTML = `<div class="empty-state">記事はまだありません</div>`;
    return;
  }
  articlesEl.innerHTML = kb.articles
    .map(
      (a) => `<details class="kb-article">
        <summary>📄 ${escapeHtml(a.title)}</summary>
        ${a.body !== undefined ? renderMarkdown(a.body) : `<p class="md-empty">本文は次回のNotion同期後に表示されます。</p>`}
        <p>${notionLink(a.url)}</p>
      </details>`
    )
    .join("");
}

/* ---------------- 概要タブ ---------------- */

function renderOverview() {
  const { tasks, matters, projects, meetings, meta } = state.data;
  const openTasks = tasks.filter((t) => !isDone(t));
  const overdue = openTasks.filter((t) => {
    const d = daysUntil(t["期日"]);
    return d !== null && d < 0;
  });
  const dueThisWeek = openTasks.filter((t) => {
    const d = daysUntil(t["期日"]);
    return d !== null && d >= 0 && d <= 7;
  });
  const recentMeetings = meetings.filter((m) => {
    const d = daysUntil(m["日時"]);
    return d !== null && d >= -30 && d <= 0;
  });

  // KPIタイル
  document.getElementById("kpi-row").innerHTML = [
    { label: "進行中タスク", value: openTasks.length, sub: `全${tasks.length}件中` },
    { label: "⚠ 期限超過", value: overdue.length, sub: "対応が必要", critical: overdue.length > 0 },
    { label: "今週期日", value: dueThisWeek.length, sub: "7日以内" },
    { label: "進行中案件", value: matters.length, sub: "案件ボード" },
    { label: "直近30日の会議", value: recentMeetings.length, sub: `議事録 全${meetings.length}件` },
  ]
    .map(
      (k) => `<div class="kpi ${k.critical ? "kpi-critical" : ""}">
        <div class="kpi-label">${k.label}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-sub">${k.sub}</div>
      </div>`
    )
    .join("");

  // 今週のフォーカス
  document.getElementById("weekly-focus").innerHTML = renderMarkdown(
    (meta.weeklyFocus || "").replace(/^## 📌 今週のフォーカス\n?/, "").replace(/^> ここに今週の重点事項を書く\n?/, "")
  );

  // タスクステータス構成
  const stCount = {};
  for (const t of tasks) {
    const s = t["ステータス"] || "未設定";
    stCount[s] = (stCount[s] || 0) + 1;
  }
  const ORDER = ["未着手", "進行中", "レビュー待ち", "完了", "見送り", "未設定"];
  const COLORS = {
    未着手: "var(--series-3)",
    進行中: "var(--series-1)",
    レビュー待ち: "var(--series-5)",
    完了: "var(--series-2)",
    見送り: "var(--gray-mark)",
    未設定: "var(--gray-mark)",
  };
  const segments = ORDER.filter((s) => stCount[s]).map((s) => ({
    label: s,
    value: stCount[s],
    color: COLORS[s] || "var(--series-6)",
  }));
  // 上記以外のステータスも落とさない
  for (const [s, v] of Object.entries(stCount)) {
    if (!ORDER.includes(s)) segments.push({ label: s, value: v, color: "var(--series-6)" });
  }
  stackedBarH(document.getElementById("chart-task-status"), segments);

  // 会議アクティビティ（直近12週）— タイムゾーンずれを避けるためローカル日付で整形する
  const localYmd = (d) => {
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  };
  const weekKey = (dstr) => {
    const d = new Date(dstr + "T00:00:00");
    const day = (d.getDay() + 6) % 7; // 月曜=0
    d.setDate(d.getDate() - day);
    return localYmd(d);
  };
  const weeks = [];
  {
    const cur = new Date(weekKey(todayStr()) + "T00:00:00");
    for (let i = 11; i >= 0; i--) {
      const d = new Date(cur);
      d.setDate(d.getDate() - i * 7);
      weeks.push(localYmd(d));
    }
  }
  const byWeek = {};
  for (const m of meetings) {
    const s = dateStart(m["日時"]);
    if (s) {
      const k = weekKey(s);
      byWeek[k] = (byWeek[k] || 0) + 1;
    }
  }
  columnChart(
    document.getElementById("chart-meetings"),
    weeks.map((w) => ({
      label: `${Number(w.slice(5, 7))}/${Number(w.slice(8, 10))}`,
      value: byWeek[w] || 0,
      tip: `${w}週: ${byWeek[w] || 0}件`,
    })),
    { unit: "件" }
  );

  // プロジェクト別タスク
  projectBars(
    document.getElementById("chart-projects"),
    projects.map((p) => {
      const s = projectTaskStats(p);
      return { name: p["プロジェクト名"] || "(無題)", open: s.open, done: s.done };
    }).sort((a, b) => (b.open + b.done) - (a.open + a.done))
  );

  // 期日が近いタスク
  const urgent = sortTasks(openTasks.filter((t) => dateStart(t["期日"]))).slice(0, 8);
  renderTable(document.getElementById("overview-tasks"), urgent, TASK_COLUMNS, openTaskDetail);

  // 直近の議事録
  const recent = sortMeetings(meetings).slice(0, 5);
  renderTable(
    document.getElementById("overview-meetings"),
    recent,
    [
      { label: "日時", cls: "num", render: (m) => escapeHtml(fmtDate(m["日時"])) },
      { label: "会議名", render: (m) => `<span class="row-title">${escapeHtml(m["会議名"])}</span>` },
      { label: "種別", render: (m) => m["会議種別"] ? `<span class="badge">${escapeHtml(m["会議種別"])}</span>` : "" },
    ],
    openMeetingDetail
  );
}

/* ---------------- タブ制御・起動 ---------------- */

function activateTab(id) {
  if (!TABS.some((t) => t.id === id)) id = "overview";
  document.querySelectorAll(".tab-bar a").forEach((a) => {
    a.classList.toggle("active", a.dataset.tab === id);
  });
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `panel-${id}`);
  });
  window.scrollTo(0, 0);
}

async function main() {
  const nav = document.querySelector(".tab-bar");
  nav.innerHTML = TABS.map(
    (t) => `<a href="#${t.id}" data-tab="${t.id}">${t.label}</a>`
  ).join("");
  window.addEventListener("hashchange", () => activateTab(location.hash.slice(1)));

  document.getElementById("drawer-backdrop").addEventListener("click", closeDrawer);
  document.querySelector(".drawer-close").addEventListener("click", closeDrawer);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDrawer();
  });

  const metaBar = document.querySelector(".meta-bar");
  try {
    const [matters, tasks, projects, meetings, knowledge, meta] = await Promise.all([
      loadJson("matters"),
      loadJson("tasks"),
      loadJson("projects"),
      loadJson("meetings"),
      loadJson("knowledge"),
      loadJson("meta"),
    ]);
    state.data = { matters, tasks, projects, meetings, knowledge, meta };
    const synced = new Date(meta.syncedAt);
    metaBar.innerHTML = `最終同期: ${synced.toLocaleString("ja-JP")}（3時間ごと自動）｜ ${meta.dashboardUrl ? `<a href="${escapeHtml(meta.dashboardUrl)}" target="_blank" rel="noopener">Notionで開く ↗</a>` : ""}`;
  } catch (e) {
    console.error(e);
    metaBar.textContent = "同期データの読み込みに失敗しました。GitHub Actionsの実行状況を確認してください。";
    document.querySelector("main").innerHTML = `<div class="card"><div class="empty-state">データを読み込めませんでした。時間をおいて再読み込みしてください。</div></div>`;
    return;
  }

  renderOverview();
  renderMattersTab();
  renderTasksTab();
  renderProjectsTab();
  renderMeetingsTab();
  renderKnowledgeTab();
  activateTab(location.hash.slice(1) || "overview");
}

main();
