// 板橋ダッシュボード SPA本体。data/*.json を読み込み、タブ・KPI・チャート・一覧・詳細ドロワーを組み立てる。

const TABS = [
  { id: "overview", label: "概要" },
  { id: "me", label: "For me" },
  { id: "nishiyama", label: "For 西山副社長" },
  { id: "calendar", label: "予定表" },
  { id: "reply", label: "返信管理" },
  { id: "matters", label: "進行中案件" },
  { id: "tasks", label: "TODO" },
  { id: "projects", label: "プロジェクト" },
  { id: "meetings", label: "議事録" },
  { id: "knowledge", label: "ナレッジ" },
];

// パーソナルビュー設定。owner はOutlook予定のowner名との部分一致、keywords は関連項目の抽出条件。
const PERSONS = [
  { id: "me", owner: "板橋", keywords: null }, // null = 自分のタスクは全件対象
  { id: "nishiyama", owner: "西山", keywords: ["西山"] },
];

const state = { data: null, calMonth: null };

/* ---------------- 復号（パスワード保護） ---------------- */

function getPass() {
  return localStorage.getItem("dash_pass") || "";
}

async function decryptJson(payload, password) {
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const base = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: unb64(payload.salt), iterations: payload.iter || 150000, hash: "SHA-256" },
    base, { name: "AES-GCM", length: 256 }, false, ["decrypt"]
  );
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(payload.iv) }, key, unb64(payload.ct)
  );
  return JSON.parse(new TextDecoder().decode(pt));
}

const isEncrypted = (obj) => !!(obj && obj.__enc === 1 && obj.ct);

// 暗号化データがあれば合言葉入力を待って復号する
async function resolveData(rawMap) {
  const names = Object.keys(rawMap);
  if (!names.some((n) => isEncrypted(rawMap[n]))) return rawMap;
  let pass = getPass();
  const probe = names.find((n) => isEncrypted(rawMap[n]));
  while (true) {
    if (pass) {
      try {
        await decryptJson(rawMap[probe], pass);
        localStorage.setItem("dash_pass", pass);
        break;
      } catch {
        pass = "";
      }
    }
    pass = await askPassphrase();
  }
  const out = {};
  for (const n of names) {
    out[n] = isEncrypted(rawMap[n]) ? await decryptJson(rawMap[n], pass) : rawMap[n];
  }
  return out;
}

function askPassphrase() {
  return new Promise((resolve) => {
    const overlay = document.getElementById("unlock-overlay");
    overlay.classList.add("open");
    const input = document.getElementById("unlock-input");
    const btn = document.getElementById("unlock-btn");
    const err = document.getElementById("unlock-error");
    if (getPass()) err.textContent = "合言葉が違います。もう一度入力してください。";
    input.value = "";
    input.focus();
    const submit = () => {
      if (!input.value) return;
      overlay.classList.remove("open");
      btn.removeEventListener("click", submit);
      input.removeEventListener("keydown", onKey);
      resolve(input.value);
    };
    const onKey = (e) => { if (e.key === "Enter") submit(); };
    btn.addEventListener("click", submit);
    input.addEventListener("keydown", onKey);
  });
}

/* ---------------- 編集API（GASプロキシ） ---------------- */

function gasUrl() {
  return localStorage.getItem("dash_gas_url") || state.data?.meta?.editEndpoint || "";
}

function canEdit() {
  return !!(gasUrl() && getPass());
}

/* ---------------- 未返信メールの取り下げ（このブラウザ内のみ非表示・Notion非連携） ---------------- */

const DISMISSED_MAIL_KEY = "dash_dismissed_mail_ids";

function mailKey(m) {
  return m.id || `${m.receivedAt}|${m.from}|${m.subject}`;
}

function getDismissedMailIds() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISMISSED_MAIL_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function dismissMail(id) {
  const set = getDismissedMailIds();
  set.add(id);
  localStorage.setItem(DISMISSED_MAIL_KEY, JSON.stringify([...set]));
}

async function gasCall(body) {
  const url = gasUrl();
  if (!url) throw new Error("編集エンドポイント未設定です（⚙設定から登録してください）");
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ token: getPass(), ...body }),
    redirect: "follow",
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "更新に失敗しました");
  return data;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.toggle("error", isError);
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), 3500);
}

function rerenderAll() {
  renderOverview();
  renderPersonTabs();
  renderCalendarTab();
  renderReplyTab();
  renderWorkload();
  renderMattersTab();
  renderTasksTab();
  renderProjectsTab();
  renderMeetingsTab();
}

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

// 期日に時刻成分（"YYYY-MM-DDTHH:MM..."）があれば "HH:MM" を返す。日付のみなら空文字
function timeOfDate(dateVal) {
  if (!dateVal) return "";
  const s = typeof dateVal === "string" ? dateVal : dateVal.start;
  if (!s || s.length < 16 || s[10] !== "T") return "";
  return s.slice(11, 16);
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

// 優先度は数値が大きいほど優先度が高い（3＞2＞1）
function priBadge(pri) {
  const n = priNumber(pri);
  if (n === null) return "";
  const cls = n >= 3 ? "pri-1" : n === 2 ? "pri-2" : "pri-3";
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

// ---- 経過時間（Slackメンション・未返信メール監視用） ----
function elapsedMs(iso) {
  return Date.now() - new Date(iso).getTime();
}
function elapsedLabel(iso) {
  const ms = elapsedMs(iso);
  if (ms < 0) return "たった今";
  const min = Math.floor(ms / 60000);
  if (min < 1) return "1分未満";
  if (min < 60) return `${min}分`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}時間${min % 60 ? (min % 60) + "分" : ""}`;
  const d = Math.floor(h / 24);
  return `${d}日${h % 24 ? (h % 24) + "時間" : ""}`;
}
function elapsedClass(iso) {
  const h = elapsedMs(iso) / 3600000;
  if (h >= 24) return "due-over";
  if (h >= 4) return "due-soon";
  return "";
}
// 開閉状態を保ったまま経過時間バッジだけを1分毎に更新する
function tickElapsed() {
  document.querySelectorAll("[data-elapsed-since]").forEach((el) => {
    el.textContent = elapsedLabel(el.dataset.elapsedSince);
    el.classList.remove("due-over", "due-soon");
    const cls = elapsedClass(el.dataset.elapsedSince);
    if (cls) el.classList.add(cls);
  });
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

function openDrawer(title, propsHtml, bodyMd, url, extraHtml = "", bind = null) {
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
  if (bind) bind(document.getElementById("drawer-content"));
}

/* ---------------- 編集フォーム ---------------- */

const TASK_STATUSES = ["未着手", "進行中", "レビュー待ち", "完了", "見送り"];

function statusOptions(rows, current) {
  const set = new Set(TASK_STATUSES);
  rows.forEach((r) => r["ステータス"] && set.add(r["ステータス"]));
  return [...set]
    .map((s) => `<option value="${escapeHtml(s)}" ${s === current ? "selected" : ""}>${escapeHtml(s)}</option>`)
    .join("");
}

function priOptions(current) {
  const n = priNumber(current);
  return `<option value="">なし</option>` + [1, 2, 3]
    .map((p) => `<option value="${p}" ${p === n ? "selected" : ""}>P${p}</option>`)
    .join("");
}

// item: 対象行 / rows: 同種の全行（ステータス候補用） / fields: 表示フィールド設定
function editFormHtml(item, rows, { withMemo = "メモ" } = {}) {
  return `
  <form class="edit-form">
    <div class="edit-grid">
      <label>ステータス
        <select name="ステータス"><option value="">未設定</option>${statusOptions(rows, item["ステータス"])}</select>
      </label>
      <label>優先度
        <select name="優先度">${priOptions(item["優先度"])}</select>
      </label>
      <label>期日
        <input type="date" name="期日" value="${escapeHtml(dateStart(item["期日"]) || "")}">
      </label>
      <label>時刻(任意)
        <input type="time" name="期日時刻" value="${escapeHtml(timeOfDate(item["期日"]))}">
      </label>
    </div>
    ${withMemo ? `<label class="edit-wide">${escapeHtml(withMemo)}
      <input type="text" name="${escapeHtml(withMemo)}" value="${escapeHtml(item[withMemo] || "")}">
    </label>` : ""}
    <div class="edit-actions">
      <button type="submit" class="btn btn-primary">保存</button>
      ${item["ステータス"] !== "完了" ? `<button type="button" class="btn btn-done">✓ 完了にする</button>` : ""}
      <button type="button" class="btn btn-danger">🗑 削除</button>
      <span class="edit-hint">${canEdit() ? "保存するとNotionに即時反映されます" : "編集には⚙設定で合言葉・編集URLの登録が必要です"}</span>
    </div>
  </form>`;
}

function bindEditForm(container, item, { onSaved, withMemo = "メモ" } = {}) {
  const form = container.querySelector(".edit-form");
  if (!form) return;
  const save = async (overrides = {}) => {
    const dueDate = form.elements["期日"].value;
    const dueTime = form.elements["期日時刻"]?.value;
    const props = {
      ステータス: form.elements["ステータス"].value,
      優先度: form.elements["優先度"].value,
      期日: dueDate ? (dueTime ? `${dueDate}T${dueTime}:00+09:00` : dueDate) : "",
      ...(withMemo && form.elements[withMemo] ? { [withMemo]: form.elements[withMemo].value } : {}),
      ...overrides,
    };
    const btns = form.querySelectorAll("button");
    btns.forEach((b) => (b.disabled = true));
    try {
      await gasCall({ action: "update", pageId: item.id, props });
      // ローカルにも反映
      if (props["ステータス"] !== undefined) item["ステータス"] = props["ステータス"] || null;
      if (props["優先度"] !== undefined) item["優先度"] = props["優先度"] || null;
      if (props["期日"] !== undefined) item["期日"] = props["期日"] ? { start: props["期日"], end: null } : null;
      if (withMemo && props[withMemo] !== undefined) item[withMemo] = props[withMemo];
      toast("保存しました（Notionに反映済み）");
      rerenderAll();
      if (onSaved) onSaved(item);
    } catch (e) {
      toast(e.message, true);
    } finally {
      btns.forEach((b) => (b.disabled = false));
    }
  };
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    save();
  });
  const doneBtn = form.querySelector(".btn-done");
  if (doneBtn) {
    doneBtn.addEventListener("click", () => {
      form.elements["ステータス"].value = "完了";
      save({ ステータス: "完了" });
    });
  }
  const delBtn = form.querySelector(".btn-danger");
  if (delBtn) {
    delBtn.addEventListener("click", async () => {
      if (delBtn.dataset.confirm !== "1") {
        delBtn.dataset.confirm = "1";
        delBtn.textContent = "🗑 本当に削除する？（もう一度クリック）";
        setTimeout(() => {
          delBtn.dataset.confirm = "";
          delBtn.textContent = "🗑 削除";
        }, 4000);
        return;
      }
      delBtn.disabled = true;
      try {
        await gasCall({ action: "archive", pageId: item.id });
        // どのコレクションに属していても取り除く
        for (const key of ["tasks", "matters", "projects", "meetings"]) {
          const arr = state.data[key];
          const i = arr.indexOf(item);
          if (i >= 0) arr.splice(i, 1);
        }
        toast("削除しました（Notionのゴミ箱へ移動・30日以内は復元可能）");
        closeDrawer();
        rerenderAll();
      } catch (e) {
        toast(e.message, true);
        delBtn.disabled = false;
      }
    });
  }
}

// 新規タスク作成フォーム
function openCreateTask() {
  const projects = state.data.projects;
  const projectOpts = `<option value="">なし</option>` + projects
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p["プロジェクト名"])}</option>`)
    .join("");
  document.getElementById("drawer-title").textContent = "＋ 新規タスク";
  document.getElementById("drawer-content").innerHTML = `
    <form class="edit-form" id="create-task-form">
      <label class="edit-wide">タスク名
        <input type="text" name="タスク名" required placeholder="例：【お名前】引継ぎ資料の確認">
      </label>
      <div class="edit-grid">
        <label>ステータス
          <select name="ステータス">${statusOptions(state.data.tasks, "未着手")}</select>
        </label>
        <label>優先度
          <select name="優先度">${priOptions(null)}</select>
        </label>
        <label>期日
          <input type="date" name="期日">
        </label>
        <label>時刻(任意)
          <input type="time" name="期日時刻">
        </label>
      </div>
      <div class="edit-grid">
        <label>プロジェクト
          <select name="プロジェクト">${projectOpts}</select>
        </label>
      </div>
      <label class="edit-wide">メモ
        <input type="text" name="メモ">
      </label>
      <div class="edit-actions">
        <button type="submit" class="btn btn-primary">作成</button>
        <span class="edit-hint">${canEdit() ? "NotionのTODOデータベースに追加されます" : "作成には⚙設定で合言葉・編集URLの登録が必要です"}</span>
      </div>
    </form>`;
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawer-backdrop").classList.add("open");
  const form = document.getElementById("create-task-form");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const dbId = state.data.meta?.sources?.tasks;
    if (!dbId) { toast("データベースIDが不明です（次回同期後に利用可能）", true); return; }
    const projId = form.elements["プロジェクト"].value;
    const dueDate = form.elements["期日"].value;
    const dueTime = form.elements["期日時刻"].value;
    const props = {
      タスク名: form.elements["タスク名"].value,
      ステータス: form.elements["ステータス"].value,
      優先度: form.elements["優先度"].value,
      期日: dueDate ? (dueTime ? `${dueDate}T${dueTime}:00+09:00` : dueDate) : "",
      メモ: form.elements["メモ"].value,
      ...(projId ? { プロジェクト: [projId] } : {}),
    };
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await gasCall({ action: "create", databaseId: dbId, props });
      state.data.tasks.push({
        id: res.id,
        url: res.url,
        タスク名: props["タスク名"],
        ステータス: props["ステータス"] || null,
        優先度: props["優先度"] || null,
        期日: props["期日"] ? { start: props["期日"], end: null } : null,
        メモ: props["メモ"],
        プロジェクト: projId
          ? [{ id: projId, name: projects.find((p) => p.id === projId)?.["プロジェクト名"] ?? null }]
          : [],
        body: "",
      });
      toast("タスクを作成しました");
      rerenderAll();
      closeDrawer();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
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
    ["担当者", escapeHtml(peopleText(t["担当者"]))],
    ["プロジェクト", escapeHtml(projectNames(t))],
  ]) + editFormHtml(t, state.data.tasks),
  t.body, t.url, "",
  (c) => bindEditForm(c, t));
}

function openMatterDetail(m) {
  openDrawer(m["案件名"] || "(無題)", propGrid([
    ["担当者", escapeHtml(peopleText(m["担当者"]))],
    ["ラベル", escapeHtml(peopleText(m["ラベル"]))],
  ]) + editFormHtml(m, state.data.matters),
  m.body, m.url, "",
  (c) => bindEditForm(c, m));
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
    ["開始日", escapeHtml(fmtDate(p["開始日"]))],
    ["担当者", escapeHtml(peopleText(p["担当者"]))],
  ]) + editFormHtml(p, state.data.projects, { withMemo: "概要" }),
  p.body, p.url, taskList,
  (c) => bindEditForm(c, p, { withMemo: "概要" }));
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
    // 優先度は数値が大きいほど優先度が高い（3＞2＞1）ので降順、未設定は最後
    return (priNumber(b["優先度"]) ?? -1) - (priNumber(a["優先度"]) ?? -1);
  });
}

const TASK_COLUMNS = [
  { label: "タスク", render: (t) => `<span class="row-title">${escapeHtml(t["タスク名"])}</span>` },
  { label: "ステータス", render: (t) => statusBadge(t["ステータス"]) },
  { label: "優先度", render: (t) => priBadge(t["優先度"]) },
  { label: "期日", cls: "num", render: (t) => dueCell(t) },
  { label: "プロジェクト", render: (t) => escapeHtml(projectNames(t)) },
  {
    label: "",
    render: (t) =>
      DONE_STATUSES.has(t["ステータス"])
        ? ""
        : `<button type="button" class="btn btn-mini btn-task-dismiss" data-id="${escapeHtml(t.id)}">取り下げ</button>`,
  },
];

async function dismissTask(id) {
  const t = state.data.tasks.find((x) => x.id === id);
  if (!t) return;
  try {
    await gasCall({ action: "update", pageId: id, props: { ステータス: "見送り" } });
    t["ステータス"] = "見送り";
    toast("取り下げました（ステータスを見送りに変更・Notionに反映済み）");
    rerenderAll();
  } catch (err) {
    toast(err.message, true);
  }
}

function bindTaskDismissButtons(container) {
  container.querySelectorAll(".btn-task-dismiss").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      btn.disabled = true;
      dismissTask(btn.dataset.id);
    });
  });
}

function renderTasksTab() {
  const tasks = sortTasks(state.data.tasks);
  const tableEl = document.getElementById("tasks-table");
  const addBtn = document.getElementById("task-add-btn");
  if (addBtn && !addBtn.dataset.bound) {
    addBtn.dataset.bound = "1";
    addBtn.addEventListener("click", openCreateTask);
  }
  const doRender = (rows) => {
    renderTable(tableEl, rows, TASK_COLUMNS, openTaskDetail);
    bindTaskDismissButtons(tableEl);
  };
  setupFilters(
    document.getElementById("tasks-filter"),
    tasks,
    [
      { allLabel: "すべてのステータス", get: (t) => t["ステータス"] },
      { allLabel: "すべてのプロジェクト", get: (t) => (t["プロジェクト"] || []).map((r) => r.name).filter(Boolean) },
    ],
    ["タスク名", "メモ", (t) => t.body],
    doRender
  );
  doRender(tasks);
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

/* ---------------- 予定表タブ ---------------- */

const OWNER_SLOTS = ["var(--series-1)", "var(--series-5)", "var(--series-3)", "var(--series-7, var(--series-6))"];

function calOwners() {
  const evs = state.data.calendar?.events || [];
  return [...new Set(evs.map((e) => e.owner))];
}

function ownerColor(owner) {
  const i = calOwners().indexOf(owner);
  return OWNER_SLOTS[i % OWNER_SLOTS.length];
}

function localYmdOf(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function ensureCalFilters() {
  if (!state.calFilters) {
    state.calFilters = new Set(["tasks", "meetings", ...calOwners().map((o) => `ev:${o}`)]);
  }
  return state.calFilters;
}

// その日のアイテム（予定・タスク期日・議事録）をまとめる
function itemsForDay(ymd) {
  const items = [];
  const filters = ensureCalFilters();
  for (const ev of state.data.calendar?.events || []) {
    if (!filters.has(`ev:${ev.owner}`)) continue;
    const s = ev.start.slice(0, 10);
    let e = (ev.end || ev.start).slice(0, 10);
    if (ev.allDay && e > s) {
      // 終日イベントのDTENDは排他的なので1日戻す
      const d = new Date(e + "T00:00:00");
      d.setDate(d.getDate() - 1);
      e = localYmdOf(d);
    }
    if (e < s) e = s;
    if (ymd >= s && ymd <= e) {
      items.push({ kind: "event", time: ev.allDay ? "" : ev.start.slice(11, 16), title: ev.title, ev });
    }
  }
  if (state.calFilters.has("tasks")) {
    for (const t of state.data.tasks) {
      if (isDone(t)) continue;
      if (dateStart(t["期日"]) === ymd) items.push({ kind: "task", time: "", title: t["タスク名"], t });
    }
  }
  if (state.calFilters.has("meetings")) {
    for (const m of state.data.meetings) {
      if (dateStart(m["日時"]) === ymd) items.push({ kind: "meeting", time: "", title: m["会議名"], m });
    }
  }
  items.sort((a, b) => (a.time || "99").localeCompare(b.time || "99"));
  return items;
}

function renderCalendarTab() {
  const cal = state.data.calendar;
  const owners = calOwners();
  ensureCalFilters();
  if (!state.calMonth) state.calMonth = todayStr().slice(0, 7);
  if (!state.calWeekStart) state.calWeekStart = mondayOf(todayStr());
  if (!state.calView) state.calView = "month";

  // 月送り・週送り（表示モードに応じて切り替え）
  const prevBtn = document.getElementById("cal-prev");
  if (!prevBtn.dataset.bound) {
    prevBtn.dataset.bound = "1";
    const shift = (n) => {
      if (state.calView === "week") {
        const d = new Date(state.calWeekStart + "T00:00:00");
        d.setDate(d.getDate() + 7 * n);
        state.calWeekStart = localYmdOf(d);
      } else {
        const [y, m] = state.calMonth.split("-").map(Number);
        const d = new Date(y, m - 1 + n, 1);
        state.calMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
      }
      renderCalendarBody();
    };
    prevBtn.addEventListener("click", () => shift(-1));
    document.getElementById("cal-next").addEventListener("click", () => shift(1));
    document.getElementById("cal-today-btn").addEventListener("click", () => {
      state.calMonth = todayStr().slice(0, 7);
      state.calWeekStart = mondayOf(todayStr());
      renderCalendarBody();
    });
  }

  // 月次／週次 表示切替
  document.querySelectorAll(".cal-view-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.view === state.calView);
    if (!btn.dataset.bound) {
      btn.dataset.bound = "1";
      btn.addEventListener("click", () => {
        state.calView = btn.dataset.view;
        document.querySelectorAll(".cal-view-btn").forEach((b) => b.classList.toggle("active", b === btn));
        renderCalendarBody();
      });
    }
  });

  // 検索
  const searchInput = document.getElementById("cal-search");
  if (searchInput && !searchInput.dataset.bound) {
    searchInput.dataset.bound = "1";
    searchInput.value = state.calSearch || "";
    searchInput.addEventListener("input", () => {
      state.calSearch = searchInput.value;
      renderCalendarBody();
    });
  }

  // フィルタ
  const filterEl = document.getElementById("cal-filters");
  filterEl.innerHTML = [
    ...owners.map((o, i) => ({ key: `ev:${o}`, label: `📅 ${o}`, color: ownerColor(o) })),
    { key: "tasks", label: "✅ タスク期日", color: "var(--status-serious)" },
    { key: "meetings", label: "📝 議事録", color: "var(--gray-mark)" },
  ]
    .map(
      (f) => `<label class="cal-filter"><input type="checkbox" data-key="${escapeHtml(f.key)}" ${state.calFilters.has(f.key) ? "checked" : ""}>
        <span class="swatch" style="background:${f.color}"></span>${escapeHtml(f.label)}</label>`
    )
    .join("");
  filterEl.querySelectorAll("input").forEach((cb) => {
    cb.addEventListener("change", () => {
      cb.checked ? state.calFilters.add(cb.dataset.key) : state.calFilters.delete(cb.dataset.key);
      renderCalendarBody();
    });
  });

  const note = document.getElementById("cal-note");
  if (!cal || !cal.events?.length) {
    note.innerHTML = `Outlook予定はまだ取り込まれていません。設定手順はREADME参照（タスク期日・議事録は表示されます）。`;
  } else {
    note.textContent = `Outlook予定 ${cal.events.length}件（取得: ${new Date(cal.updatedAt).toLocaleString("ja-JP")}）`;
  }

  renderCalendarBody();
  renderTimeline();
}

function renderCalendarBody() {
  const q = (state.calSearch || "").trim();
  if (q) return renderCalendarSearch(q);
  if (state.calView === "week") return renderCalendarWeek();
  return renderCalendarGrid();
}

function renderCalendarGrid() {
  const [y, mo] = state.calMonth.split("-").map(Number);
  document.getElementById("cal-title").textContent = `${y}年${mo}月`;
  const first = new Date(y, mo - 1, 1);
  const startOffset = (first.getDay() + 6) % 7; // 月曜=0
  const gridStart = new Date(y, mo - 1, 1 - startOffset);
  const today = todayStr();
  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart);
    d.setDate(gridStart.getDate() + i);
    const ymd = localYmdOf(d);
    const inMonth = d.getMonth() === mo - 1;
    const items = itemsForDay(ymd);
    const chips = items.slice(0, 4).map((it) => {
      if (it.kind === "event") {
        return `<div class="cal-chip" style="--chip:${ownerColor(it.ev.owner)}" data-day="${ymd}">${it.time ? `<span class="chip-time">${it.time}</span>` : ""}${escapeHtml(it.title)}${effectiveJoinUrl(it.ev) ? " 🔵" : ""}</div>`;
      }
      if (it.kind === "task") {
        const over = ymd < today;
        return `<div class="cal-chip chip-task ${over ? "chip-over" : ""}" data-day="${ymd}">✅ ${escapeHtml(it.title)}</div>`;
      }
      return `<div class="cal-chip chip-meeting" data-day="${ymd}">📝 ${escapeHtml(it.title)}</div>`;
    });
    if (items.length > 4) chips.push(`<div class="cal-more" data-day="${ymd}">＋${items.length - 4}件</div>`);
    const dow = i % 7;
    cells.push(`<div class="cal-cell ${inMonth ? "" : "cal-out"} ${ymd === today ? "cal-today" : ""} ${dow >= 5 ? "cal-weekend" : ""}" data-day="${ymd}">
      <div class="cal-date">${d.getDate()}</div>${chips.join("")}
    </div>`);
  }
  const grid = document.getElementById("cal-grid");
  grid.classList.remove("cal-grid--week", "cal-grid--search");
  grid.innerHTML =
    ["月", "火", "水", "木", "金", "土", "日"].map((w) => `<div class="cal-dow">${w}</div>`).join("") +
    cells.join("");
  grid.querySelectorAll(".cal-cell").forEach((cell) => {
    cell.addEventListener("click", () => openDayDetail(cell.dataset.day));
  });
}

function weekRangeLabel(startYmd) {
  const start = new Date(startYmd + "T00:00:00");
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  return `${start.getFullYear()}年${start.getMonth() + 1}/${start.getDate()} 〜 ${end.getMonth() + 1}/${end.getDate()}`;
}

// 週次表示: 曜日ごとに列を作り、その日の予定・タスク期日・議事録を全件（省略なし）インライン表示する
function renderCalendarWeek() {
  document.getElementById("cal-title").textContent = weekRangeLabel(state.calWeekStart);
  const today = todayStr();
  const dowLabels = ["月", "火", "水", "木", "金", "土", "日"];
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(state.calWeekStart + "T00:00:00");
    d.setDate(d.getDate() + i);
    days.push({ ymd: localYmdOf(d), d, dow: dowLabels[i] });
  }
  const grid = document.getElementById("cal-grid");
  grid.classList.remove("cal-grid--search");
  grid.classList.add("cal-grid--week");
  grid.innerHTML = days
    .map(({ ymd, d, dow }) => {
      const items = itemsForDay(ymd);
      const body = items.length
        ? `<ul class="day-list">${items
            .map((it) => {
              if (it.kind === "event") return eventItemHtml(it.ev, it.time || "終日");
              if (it.kind === "task")
                return `<li class="day-click" data-task-id="${escapeHtml(it.t.id)}"><span class="day-time">期日</span>✅ ${escapeHtml(it.title)}</li>`;
              return `<li class="day-click" data-meeting-id="${escapeHtml(it.m.id)}"><span class="day-time">MTG</span>📝 ${escapeHtml(it.title)}</li>`;
            })
            .join("")}</ul>`
        : `<div class="empty-state" style="padding:14px 4px">予定はありません</div>`;
      return `<div class="cal-week-day ${ymd === today ? "cal-today" : ""}">
        <div class="cal-week-day-head">${dow} ${d.getMonth() + 1}/${d.getDate()}</div>
        ${body}
      </div>`;
    })
    .join("");
  grid.querySelectorAll(".day-click").forEach((li) => {
    li.addEventListener("click", () => {
      if (li.dataset.taskId) {
        const t = state.data.tasks.find((x) => x.id === li.dataset.taskId);
        if (t) openTaskDetail(t);
      } else if (li.dataset.meetingId) {
        const m = state.data.meetings.find((x) => x.id === li.dataset.meetingId);
        if (m) openMeetingDetail(m);
      }
    });
  });
  bindEventAccordions(grid);
}

// 検索結果表示: 予定表全期間のイベントをタイトル・場所・本文でキーワード検索する
function renderCalendarSearch(q) {
  const query = q.toLowerCase();
  const events = (state.data.calendar?.events || [])
    .filter((ev) => [ev.title, ev.location, ev.body].some((f) => f && f.toLowerCase().includes(query)))
    .sort((a, b) => a.start.localeCompare(b.start));
  document.getElementById("cal-title").textContent = `🔍「${q}」の検索結果（${events.length}件）`;
  const grid = document.getElementById("cal-grid");
  grid.classList.remove("cal-grid--week");
  grid.classList.add("cal-grid--search");
  if (!events.length) {
    grid.innerHTML = `<div class="empty-state">該当する予定は見つかりませんでした</div>`;
    return;
  }
  grid.innerHTML = `<ul class="day-list">${events
    .map((ev) => eventItemHtml(ev, `${ev.start.slice(0, 10)}${ev.allDay ? "" : " " + ev.start.slice(11, 16)}`))
    .join("")}</ul>`;
  bindEventAccordions(grid);
}

// ---- Zoom等参加リンクの手動上書き（ブラウザのlocalStorageに保存。予定表は自動同期で作り直されるため） ----
function zoomOverrideKey(ev) {
  return `${ev.title}|${ev.start}`;
}
function getZoomOverrides() {
  try {
    return JSON.parse(localStorage.getItem("dash_zoom_overrides") || "{}");
  } catch {
    return {};
  }
}
function setZoomOverrideByKey(key, url) {
  const map = getZoomOverrides();
  if (url) map[key] = url;
  else delete map[key];
  localStorage.setItem("dash_zoom_overrides", JSON.stringify(map));
}
function effectiveJoinUrl(ev) {
  return ev.joinUrl || getZoomOverrides()[zoomOverrideKey(ev)] || null;
}

// 予定1件分のインライン展開アイテム（日ドロワー・For me・For西山副社長で共通利用）
function eventItemHtml(ev, timeLabel) {
  const joinUrl = effectiveJoinUrl(ev);
  const isManual = !ev.joinUrl && joinUrl;
  const key = escapeHtml(zoomOverrideKey(ev));
  const head = `<div class="day-row">
    <span class="day-time">${escapeHtml(timeLabel)}</span>
    <span class="swatch" style="background:${ownerColor(ev.owner)}"></span>
    <span class="day-row-title">${escapeHtml(ev.title)}</span>
    ${ev.location ? `<small class="day-loc">${escapeHtml(ev.location)}</small>` : ""}
    <span class="day-expand-caret">▾</span>
  </div>`;
  const zoomRow = joinUrl
    ? `<a class="btn btn-primary" target="_blank" rel="noopener" href="${escapeHtml(joinUrl)}">🔵 参加する</a>${
        isManual ? `<button type="button" class="btn zoom-edit-btn">✎ リンクを変更</button>` : ""
      }`
    : `<form class="zoom-add-form">
        <input type="url" placeholder="Zoom/TeamsのURLを貼り付け" required>
        <button type="submit" class="btn btn-primary">保存</button>
      </form>`;
  const detail = `<div class="day-expand"><div><div class="day-expand-inner">
    ${ev.location ? `<div class="day-loc-full">📍 ${escapeHtml(ev.location)}</div>` : ""}
    ${ev.body ? `<div class="day-body-text">${escapeHtml(ev.body)}</div>` : ""}
    <div class="day-zoom-row">${zoomRow}</div>
  </div></div></div>`;
  return `<li class="day-event" data-zoom-key="${key}">${head}${detail}</li>`;
}

// 参加リンク行をその場で差し替える（保存後もアコーディオンを開いたまま・全体再描画しない）
function renderZoomRow(li, joinUrl, isManual) {
  const zoomRow = li.querySelector(".day-zoom-row");
  if (!zoomRow) return;
  zoomRow.innerHTML = joinUrl
    ? `<a class="btn btn-primary" target="_blank" rel="noopener" href="${escapeHtml(joinUrl)}">🔵 参加する</a>${
        isManual ? `<button type="button" class="btn zoom-edit-btn">✎ リンクを変更</button>` : ""
      }`
    : `<form class="zoom-add-form">
        <input type="url" placeholder="Zoom/TeamsのURLを貼り付け" required>
        <button type="submit" class="btn btn-primary">保存</button>
      </form>`;
  const editBtn = zoomRow.querySelector(".zoom-edit-btn");
  if (editBtn) {
    editBtn.addEventListener("click", () => {
      setZoomOverrideByKey(li.dataset.zoomKey, null);
      renderZoomRow(li, null, false);
    });
  }
  const form = zoomRow.querySelector(".zoom-add-form");
  if (form) bindZoomForm(form, li);
}
function bindZoomForm(form, li) {
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const url = form.querySelector("input").value.trim();
    if (!url) return;
    setZoomOverrideByKey(li.dataset.zoomKey, url);
    renderZoomRow(li, url, true);
    toast("Zoomリンクを保存しました（このブラウザに保存）");
  });
}

// eventItemHtmlで作ったliの開閉・Zoomリンク保存フォームを配線する
function bindEventAccordions(container) {
  container.querySelectorAll(".day-event").forEach((li) => {
    li.querySelector(".day-row").addEventListener("click", () => li.classList.toggle("open"));
    const editBtn = li.querySelector(".zoom-edit-btn");
    if (editBtn) {
      editBtn.addEventListener("click", () => {
        setZoomOverrideByKey(li.dataset.zoomKey, null);
        renderZoomRow(li, null, false);
      });
    }
    const form = li.querySelector(".zoom-add-form");
    if (form) bindZoomForm(form, li);
  });
}

// ---- 会議開始時刻の自動通知（自分の予定・Zoomリンクがある会議のみ） ----
// ブラウザの制約上、クリック無しで自動的にZoomへ遷移させることはできない（ポップアップブロック対象になる）。
// 代わりに開始時刻になったら通知バナー＋Notification APIで知らせ、ワンクリックで参加できるようにする。
const notifiedMeetings = new Set();
function checkUpcomingMeetings() {
  const events = state.data?.calendar?.events || [];
  const now = Date.now();
  for (const ev of events) {
    if (ev.owner !== "板橋" || ev.allDay) continue;
    const joinUrl = effectiveJoinUrl(ev);
    if (!joinUrl) continue;
    const key = zoomOverrideKey(ev);
    if (notifiedMeetings.has(key)) continue;
    const startMs = new Date(ev.start).getTime();
    if (Number.isNaN(startMs)) continue;
    if (now >= startMs && now - startMs < 10 * 60000) {
      notifiedMeetings.add(key);
      notifyMeetingStart(ev, joinUrl);
    }
  }
}
function notifyMeetingStart(ev, joinUrl) {
  if (typeof Notification !== "undefined" && Notification.permission === "granted") {
    try {
      const n = new Notification(`🟢 ${ev.title} が始まりました`, { body: "クリックでZoomに参加できます" });
      n.onclick = () => {
        window.open(joinUrl, "_blank");
        n.close();
      };
    } catch {
      // 通知に失敗してもバナー表示は続行
    }
  }
  showMeetingBanner(ev, joinUrl);
}
function showMeetingBanner(ev, joinUrl) {
  const bar = document.createElement("div");
  bar.className = "meeting-banner";
  bar.innerHTML = `
    <span>🟢 <strong>${escapeHtml(ev.title)}</strong> が始まりました</span>
    <a class="btn btn-primary" target="_blank" rel="noopener" href="${escapeHtml(joinUrl)}">参加する</a>
    <button type="button" class="icon-btn meeting-banner-close" aria-label="閉じる">×</button>`;
  bar.querySelector(".meeting-banner-close").addEventListener("click", () => bar.remove());
  document.body.appendChild(bar);
}

function openDayDetail(ymd) {
  const items = itemsForDay(ymd);
  const d = new Date(ymd + "T00:00:00");
  const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
  document.getElementById("drawer-title").textContent = `${ymd}（${w}）`;
  document.getElementById("drawer-content").innerHTML = items.length
    ? `<ul class="day-list">${items
        .map((it, i) => {
          if (it.kind === "event") return eventItemHtml(it.ev, it.time || "終日");
          if (it.kind === "task")
            return `<li class="day-click" data-i="${i}"><span class="day-time">期日</span>✅ ${escapeHtml(it.title)} ${statusBadge(it.t["ステータス"])}</li>`;
          return `<li class="day-click" data-i="${i}"><span class="day-time">MTG</span>📝 ${escapeHtml(it.title)}</li>`;
        })
        .join("")}</ul>`
    : `<div class="empty-state">予定はありません</div>`;
  document.getElementById("drawer").classList.add("open");
  document.getElementById("drawer-backdrop").classList.add("open");
  document.querySelectorAll("#drawer-content .day-click").forEach((li) => {
    li.addEventListener("click", () => {
      const it = items[Number(li.dataset.i)];
      if (it.kind === "task") openTaskDetail(it.t);
      else if (it.kind === "meeting") openMeetingDetail(it.m);
    });
  });
  bindEventAccordions(document.getElementById("drawer-content"));
}

// タスクタイムライン（今日±: プロジェクト行 × 期日マーカー）
function renderTimeline() {
  const container = document.getElementById("timeline");
  const open = state.data.tasks.filter((t) => !isDone(t) && dateStart(t["期日"]));
  if (!open.length) {
    container.innerHTML = `<div class="empty-state">期日つきの未完了タスクはありません</div>`;
    return;
  }
  const today = new Date(todayStr() + "T00:00:00");
  const start = new Date(today); start.setDate(start.getDate() - 7);
  const end = new Date(today); end.setDate(end.getDate() + 28);
  const spanMs = end - start;
  const groups = new Map();
  for (const t of open) {
    const proj = projectNames(t) || "その他";
    if (!groups.has(proj)) groups.set(proj, []);
    groups.get(proj).push(t);
  }
  const rows = [...groups.entries()];
  const W = 720, LABEL = 120, ROW_H = 30, TOP = 22;
  const innerW = W - LABEL - 16;
  const H = TOP + rows.length * ROW_H + 8;
  const xOf = (dstr) => {
    const ms = new Date(dstr + "T00:00:00") - start;
    return LABEL + Math.max(0, Math.min(1, ms / spanMs)) * innerW;
  };
  // 週の目盛り
  const ticks = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 7)) {
    const x = xOf(localYmdOf(d));
    ticks.push(`<line x1="${x}" y1="${TOP - 6}" x2="${x}" y2="${H - 4}" stroke="var(--grid)"></line>
      <text x="${x + 3}" y="${TOP - 10}" font-size="10" fill="var(--muted)">${d.getMonth() + 1}/${d.getDate()}</text>`);
  }
  const todayX = xOf(todayStr());
  const marks = rows.map(([proj, list], i) => {
    const y = TOP + i * ROW_H + ROW_H / 2;
    const dots = list.map((t) => {
      const due = dateStart(t["期日"]);
      const over = due < todayStr();
      const soon = !over && daysUntil(t["期日"]) <= 3;
      const color = over ? "var(--status-critical)" : soon ? "var(--status-serious)" : "var(--series-1)";
      return `<circle cx="${xOf(due)}" cy="${y}" r="6" fill="${color}" stroke="var(--surface)" stroke-width="2" class="tl-dot" data-id="${escapeHtml(t.id)}" data-tip="${escapeHtml(`${due} ${t["タスク名"]}${over ? "（期限超過）" : ""}`)}"></circle>`;
    });
    return `<text x="${LABEL - 8}" y="${y + 4}" text-anchor="end" font-size="11" fill="var(--ink-2)">${escapeHtml(proj.length > 9 ? proj.slice(0, 8) + "…" : proj)}</text>
      <line x1="${LABEL}" y1="${y}" x2="${W - 16}" y2="${y}" stroke="var(--grid)"></line>${dots.join("")}`;
  });
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="タスクタイムライン">
      ${ticks.join("")}
      <line x1="${todayX}" y1="${TOP - 6}" x2="${todayX}" y2="${H - 4}" stroke="var(--status-critical)" stroke-width="1.5" stroke-dasharray="4 3"></line>
      <text x="${todayX + 3}" y="${H - 8}" font-size="10" fill="var(--status-critical)">今日</text>
      ${marks.join("")}
    </svg>
    <div class="chart-legend">
      <span class="key"><span class="swatch" style="background:var(--status-critical)"></span>期限超過</span>
      <span class="key"><span class="swatch" style="background:var(--status-serious)"></span>3日以内</span>
      <span class="key"><span class="swatch" style="background:var(--series-1)"></span>それ以降</span>
      <span class="key" style="color:var(--muted)">●クリックで詳細</span>
    </div>`;
  bindTooltip(container.querySelector("svg"));
  container.querySelectorAll(".tl-dot").forEach((dot) => {
    dot.style.cursor = "pointer";
    dot.addEventListener("click", () => {
      const t = state.data.tasks.find((x) => x.id === dot.dataset.id);
      if (t) openTaskDetail(t);
    });
  });
}

/* ---------------- 返信管理タブ（Slackメンション・Outlookメール監視） ---------------- */

function renderReplyTab() {
  const slack = state.data.slack || { mentions: [], todosCreated: [] };
  const mail = state.data.mail || { items: [] };

  const unreplied = [...(slack.mentions || []).filter((m) => !m.isReplied)].sort((a, b) =>
    a.mentionedAt.localeCompare(b.mentionedAt)
  );
  const replied = (slack.mentions || []).filter((m) => m.isReplied);

  const slackKpi = document.getElementById("reply-slack-kpi");
  if (slackKpi) {
    slackKpi.innerHTML = `
      <div class="kpi ${unreplied.length ? "kpi-critical" : ""}"><div class="kpi-label">未返信メンション</div><div class="kpi-value">${unreplied.length}</div></div>
      <div class="kpi"><div class="kpi-label">返信済み（表示中）</div><div class="kpi-value">${replied.length}</div></div>
      <div class="kpi"><div class="kpi-label">TODO化済み</div><div class="kpi-value">${(slack.todosCreated || []).length}</div></div>`;
  }

  const slackList = document.getElementById("reply-slack-list");
  if (slackList) {
    const rows = [...unreplied, ...replied];
    slackList.innerHTML = !rows.length
      ? `<div class="empty-state">Slack監視データはまだありません</div>`
      : `<ul class="day-list">${rows
          .map((m, i) => {
            const timeHtml = m.isReplied
              ? `<span class="day-time">返信済</span>`
              : `<span class="day-time ${elapsedClass(m.mentionedAt)}" data-elapsed-since="${escapeHtml(m.mentionedAt)}">${elapsedLabel(m.mentionedAt)}</span>`;
            return `<li class="day-event" data-i="${i}">
              <div class="day-row">
                ${timeHtml}
                <span class="day-row-title">${escapeHtml(m.channelName || m.channel || "DM")} ・ ${escapeHtml(m.authorName || m.author || "")}</span>
                <span class="day-expand-caret">▾</span>
              </div>
              <div class="day-expand"><div><div class="day-expand-inner">
                <div class="day-body-text">${escapeHtml(m.text || "")}</div>
                ${m.permalink ? `<a class="btn btn-primary" target="_blank" rel="noopener" href="${escapeHtml(m.permalink)}">💬 Slackで開く</a>` : ""}
              </div></div></div>
            </li>`;
          })
          .join("")}</ul>`;
    slackList.querySelectorAll(".day-event").forEach((li) => {
      li.querySelector(".day-row").addEventListener("click", () => li.classList.toggle("open"));
    });
  }
  const slackNote = document.getElementById("reply-slack-note");
  if (slackNote) {
    slackNote.textContent = slack.fetchedAt
      ? `最終確認: ${new Date(slack.fetchedAt).toLocaleString("ja-JP")}（1時間ごと自動、:todo_itabashi3:スタンプでTODO化）`
      : "Slack監視はまだ設定されていません。";
  }

  // TODO化した項目一覧（クリックでタスク詳細を開く。ローカルにタスクが見つからなければNotionを別タブで開く）
  const todosList = document.getElementById("reply-slack-todos");
  if (todosList) {
    const created = [...(slack.todosCreated || [])].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    todosList.innerHTML = !created.length
      ? `<div class="empty-state">TODO化した項目はまだありません</div>`
      : `<ul class="day-list">${created
          .map(
            (c, i) => `<li class="day-click" data-i="${i}">
              <span class="day-time">${escapeHtml((c.createdAt || "").slice(0, 16).replace("T", " "))}</span>
              <span>${escapeHtml((c.text || "").slice(0, 70))}</span>
              ${c.taskId ? `<button type="button" class="btn btn-mini btn-todo-dismiss" data-i="${i}">取り下げ</button>` : ""}
            </li>`
          )
          .join("")}</ul>`;
    todosList.querySelectorAll(".day-click").forEach((li) => {
      li.addEventListener("click", () => {
        const c = created[Number(li.dataset.i)];
        const t = c.taskId ? state.data.tasks.find((x) => x.id === c.taskId) : null;
        if (t) openTaskDetail(t);
        else if (c.notionUrl) window.open(c.notionUrl, "_blank", "noopener");
        else toast("開き先の情報がありません", true);
      });
    });
    todosList.querySelectorAll(".btn-todo-dismiss").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const c = created[Number(btn.dataset.i)];
        if (!c || !c.taskId) return;
        btn.disabled = true;
        try {
          await gasCall({ action: "update", pageId: c.taskId, props: { ステータス: "見送り" } });
          const t = state.data.tasks.find((x) => x.id === c.taskId);
          if (t) t["ステータス"] = "見送り";
          toast("取り下げました（ステータスを見送りに変更・Notionに反映済み）");
          rerenderAll();
        } catch (err) {
          toast(err.message, true);
          btn.disabled = false;
        }
      });
    });
  }

  // Outlookメール監視
  const dismissedMailIds = getDismissedMailIds();
  const mailItems = [...(mail.items || [])].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const mailUnreplied = mailItems.filter((m) => m.isUnreplied && !dismissedMailIds.has(mailKey(m)));

  const mailKpi = document.getElementById("reply-mail-kpi");
  if (mailKpi) {
    mailKpi.innerHTML = `
      <div class="kpi ${mailUnreplied.length ? "kpi-critical" : ""}"><div class="kpi-label">未返信メール</div><div class="kpi-value">${mailUnreplied.length}</div></div>`;
  }

  const mailList = document.getElementById("reply-mail-list");
  if (mailList) {
    mailList.innerHTML = !mailUnreplied.length
      ? `<div class="empty-state">未返信メールはありません</div>`
      : `<ul class="day-list">${mailUnreplied
          .map(
            (m, i) => `<li data-i="${i}">
              <span class="day-time ${elapsedClass(m.receivedAt)}" data-elapsed-since="${escapeHtml(m.receivedAt)}">${elapsedLabel(m.receivedAt)}</span>
              <span>${escapeHtml(m.mailbox || "")} ・ ${escapeHtml(m.fromName || m.from || "")}：${escapeHtml(m.subject || "(件名なし)")}</span>
              <button type="button" class="btn btn-mini btn-mail-dismiss" data-i="${i}">取り下げ</button>
            </li>`
          )
          .join("")}</ul>`;
    mailList.querySelectorAll(".btn-mail-dismiss").forEach((btn) => {
      btn.addEventListener("click", () => {
        const m = mailUnreplied[Number(btn.dataset.i)];
        if (!m) return;
        dismissMail(mailKey(m));
        toast("この端末上で非表示にしました");
        renderReplyTab();
      });
    });
  }
  const mailNote = document.getElementById("reply-mail-note");
  if (mailNote) {
    mailNote.textContent = mail.fetchedAt
      ? `最終確認: ${new Date(mail.fetchedAt).toLocaleString("ja-JP")}（1時間ごと自動、対象: ${(mail.mailboxes || []).join(", ") || "-"}）`
      : "メール監視はまだ設定されていません。";
  }

  renderReplyMini(unreplied, mailUnreplied);
}

// 概要タブ用の軽量サマリー（返信管理タブへのショートカット）
function renderReplyMini(unrepliedMentions, unrepliedMails) {
  const card = document.getElementById("reply-mini-card");
  const list = document.getElementById("reply-mini-list");
  if (!card || !list) return;
  const total = unrepliedMentions.length + unrepliedMails.length;
  card.style.display = total ? "" : "none";
  if (!total) return;
  const rows = [
    ...unrepliedMentions.slice(0, 3).map((m) => ({
      label: `💬 ${m.channelName || m.channel || "DM"}`,
      sub: m.text || "",
      since: m.mentionedAt,
    })),
    ...unrepliedMails.slice(0, 3).map((m) => ({
      label: `📧 ${m.fromName || m.from || ""}`,
      sub: m.subject || "",
      since: m.receivedAt,
    })),
  ];
  list.innerHTML = `<ul class="day-list">${rows
    .map(
      (r) => `<li class="day-click">
        <span class="day-time ${elapsedClass(r.since)}" data-elapsed-since="${escapeHtml(r.since)}">${elapsedLabel(r.since)}</span>
        <span>${escapeHtml(r.label)}：${escapeHtml((r.sub || "").slice(0, 40))}</span>
      </li>`
    )
    .join("")}</ul>`;
  list.querySelectorAll(".day-click").forEach((li) => {
    li.addEventListener("click", () => {
      location.hash = "#reply";
    });
  });
}

/* ---------------- パーソナルビュー（For me / For 西山副社長） ---------------- */

function personEvents(owner, fromYmd, toYmd) {
  return (state.data.calendar?.events || [])
    .filter((e) => e.owner && e.owner.includes(owner))
    .filter((e) => {
      const s = e.start.slice(0, 10);
      return s >= fromYmd && s <= toYmd;
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

function matchesKeywords(text, keywords) {
  if (!text) return false;
  return keywords.some((k) => String(text).includes(k));
}

function eventListHtml(events, emptyMsg) {
  if (!events.length) return `<div class="empty-state">${escapeHtml(emptyMsg)}</div>`;
  const byDay = new Map();
  for (const e of events) {
    const d = e.start.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(e);
  }
  return [...byDay.entries()]
    .map(([day, evs]) => {
      const d = new Date(day + "T00:00:00");
      const w = ["日", "月", "火", "水", "木", "金", "土"][d.getDay()];
      const isToday = day === todayStr();
      return `<div class="pv-day ${isToday ? "pv-today" : ""}">
        <div class="pv-day-head">${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}（${w}）${isToday ? "・今日" : ""}</div>
        <ul class="day-list">${evs
          .map((e) => eventItemHtml(e, e.allDay ? "終日" : e.start.slice(11, 16)))
          .join("")}</ul>
      </div>`;
    })
    .join("");
}

function renderPersonTab(person) {
  const panel = document.getElementById(`panel-${person.id}`);
  const today = todayStr();
  const weekEnd = localYmdOf(new Date(Date.now() + 7 * 86400000));

  // 予定
  const events = personEvents(person.owner, today, weekEnd);
  const pvSchedule = panel.querySelector(".pv-schedule");
  pvSchedule.innerHTML = eventListHtml(
    events,
    state.data.calendar?.events?.length
      ? "直近7日間の予定はありません"
      : "Outlook予定は未取り込みです（設定手順はREADME参照）"
  );
  bindEventAccordions(pvSchedule);

  // 関連タスク
  const open = state.data.tasks.filter((t) => !isDone(t));
  const related = person.keywords
    ? open.filter(
        (t) =>
          matchesKeywords(t["タスク名"], person.keywords) ||
          matchesKeywords(t["メモ"], person.keywords) ||
          matchesKeywords(t.body, person.keywords) ||
          matchesKeywords(projectNames(t), person.keywords)
      )
    : open;
  renderTable(panel.querySelector(".pv-tasks"), sortTasks(related), TASK_COLUMNS, openTaskDetail);

  // 関連案件・議事録（キーワード指定があるビューのみ）
  const extra = panel.querySelector(".pv-extra");
  if (person.keywords && extra) {
    const matters = state.data.matters.filter(
      (m) =>
        matchesKeywords(m["案件名"], person.keywords) ||
        matchesKeywords(m["メモ"], person.keywords) ||
        matchesKeywords(m.body, person.keywords)
    );
    const meetings = sortMeetings(
      state.data.meetings.filter(
        (m) =>
          matchesKeywords(m["会議名"], person.keywords) ||
          matchesKeywords(peopleText(m["参加者"]), person.keywords) ||
          matchesKeywords(m.body, person.keywords)
      )
    ).slice(0, 5);
    extra.innerHTML = `
      ${matters.length ? `<h2 style="margin-top:14px">関連する進行中案件</h2>` : ""}
      <div class="pv-matters"></div>
      ${meetings.length ? `<h2 style="margin-top:14px">関連する議事録（直近5件）</h2>` : ""}
      <div class="pv-meetings"></div>`;
    if (matters.length) {
      renderTable(
        extra.querySelector(".pv-matters"),
        matters,
        [
          { label: "案件名", render: (m) => `<span class="row-title">${escapeHtml(m["案件名"])}</span>` },
          { label: "ステータス", render: (m) => statusBadge(m["ステータス"]) },
          { label: "メモ", render: (m) => escapeHtml(m["メモ"]) },
        ],
        openMatterDetail
      );
    }
    if (meetings.length) {
      renderTable(
        extra.querySelector(".pv-meetings"),
        meetings,
        [
          { label: "日時", cls: "num", render: (m) => escapeHtml(fmtDate(m["日時"])) },
          { label: "会議名", render: (m) => `<span class="row-title">${escapeHtml(m["会議名"])}</span>` },
          { label: "種別", render: (m) => (m["会議種別"] ? `<span class="badge">${escapeHtml(m["会議種別"])}</span>` : "") },
        ],
        openMeetingDetail
      );
    }
  }
}

function renderPersonTabs() {
  PERSONS.forEach(renderPersonTab);
}

/* ---------------- 工数（会議時間）集計 ---------------- */

const PROJ_SLOTS = [
  "var(--series-1)", "var(--series-2)", "var(--series-3)", "var(--series-4)",
  "var(--series-5)", "var(--series-6)", "var(--series-7)", "var(--series-8)",
];

// プロジェクト名から照合キーワードを生成（長いもの優先で部分一致）
function projectMatchers() {
  const names = state.data.projects.map((p) => p["プロジェクト名"]).filter(Boolean);
  const variants = [];
  for (const name of names) {
    variants.push([name, name]);
    const stripped = name.replace(/(定例|関連|管理)$/, "");
    if (stripped.length >= 2 && stripped !== name) variants.push([stripped, name]);
  }
  return variants.sort((a, b) => b[0].length - a[0].length);
}

function projColor(name) {
  const names = state.data.projects.map((p) => p["プロジェクト名"]).filter(Boolean);
  const i = names.indexOf(name);
  return i >= 0 ? PROJ_SLOTS[i % PROJ_SLOTS.length] : "var(--gray-mark)";
}

function eventHours(ev) {
  if (ev.allDay || !ev.end) return 0;
  const ms = new Date(ev.end) - new Date(ev.start);
  return ms > 0 && ms < 86400000 ? ms / 3600000 : 0;
}

function mondayOf(ymd) {
  const d = new Date(ymd + "T00:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return localYmdOf(d);
}

// owner（自分）の予定を直近nWeeks週×プロジェクト別に集計
function computeWorkload(nWeeks = 4) {
  const matchers = projectMatchers();
  const weeks = [];
  const cur = mondayOf(todayStr());
  for (let i = nWeeks - 1; i >= 0; i--) {
    const d = new Date(cur + "T00:00:00");
    d.setDate(d.getDate() - i * 7);
    weeks.push(localYmdOf(d));
  }
  const byWeek = new Map(weeks.map((w) => [w, new Map()]));
  const events = (state.data.calendar?.events || []).filter(
    (e) => e.owner && e.owner.includes(PERSONS[0].owner)
  );
  for (const ev of events) {
    const h = eventHours(ev);
    if (!h) continue;
    const wk = mondayOf(ev.start.slice(0, 10));
    if (!byWeek.has(wk)) continue;
    const proj = matchers.find(([v]) => ev.title.includes(v))?.[1] ?? "その他";
    const m = byWeek.get(wk);
    m.set(proj, (m.get(proj) || 0) + h);
  }
  return { weeks, byWeek };
}

// 横バー（時間・案件別）
function workloadBars(container, rows) {
  if (!rows.length) {
    container.innerHTML = `<div class="empty-state">今週の会議はありません</div>`;
    return;
  }
  const max = Math.max(...rows.map((r) => r.hours));
  const W = 600, ROW_H = 28, LABEL = 110;
  const innerW = W - LABEL - 64;
  const H = rows.length * ROW_H + 4;
  const parts = rows.map((r, i) => {
    const y = i * ROW_H + 5;
    const w = Math.max((r.hours / max) * innerW, 2);
    return `
      <text x="${LABEL - 8}" y="${y + 13}" text-anchor="end" font-size="11" fill="var(--ink-2)">${escapeHtml(r.name.length > 9 ? r.name.slice(0, 8) + "…" : r.name)}</text>
      <rect x="${LABEL}" y="${y}" width="${w}" height="18" rx="4" fill="${r.color}" data-tip="${escapeHtml(`${r.name}: ${r.hours.toFixed(1)}時間`)}"></rect>
      <text x="${LABEL + w + 6}" y="${y + 13}" font-size="11" fill="var(--ink-2)" font-variant-numeric="tabular-nums">${r.hours.toFixed(1)}h</text>`;
  });
  container.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="案件別会議時間">${parts.join("")}</svg>`;
  bindTooltip(container.querySelector("svg"));
}

// 週別スタック棒（時間×案件）
function stackedColumns(container, weekData) {
  const totals = weekData.map((w) => w.segs.reduce((s, x) => s + x.value, 0));
  if (!totals.some((t) => t > 0)) {
    container.innerHTML = `<div class="empty-state">データがありません</div>`;
    return;
  }
  const W = 600, H = 208, PAD_L = 34, PAD_B = 22, PAD_T = 18, GAP = 2;
  const max = Math.max(...totals);
  const innerH = H - PAD_T - PAD_B;
  const innerW = W - PAD_L - 8;
  const bw = Math.min(56, innerW / weekData.length - 16);
  const grid = [];
  const steps = 4;
  for (let i = 1; i <= steps; i++) {
    const v = (max / steps) * i;
    const y = PAD_T + innerH - (v / max) * innerH;
    grid.push(`<line x1="${PAD_L}" y1="${y}" x2="${W - 4}" y2="${y}" stroke="var(--grid)"></line>
      <text x="${PAD_L - 5}" y="${y + 3.5}" text-anchor="end" font-size="10" fill="var(--muted)">${Math.round(v)}h</text>`);
  }
  const cols = weekData.map((w, i) => {
    const cx = PAD_L + (innerW / weekData.length) * (i + 0.5);
    let y = PAD_T + innerH;
    const rects = w.segs
      .filter((s) => s.value > 0)
      .map((s) => {
        const h = (s.value / max) * innerH;
        y -= h;
        const r = `<rect x="${cx - bw / 2}" y="${y}" width="${bw}" height="${Math.max(h - GAP, 1)}" rx="3" fill="${s.color}" data-tip="${escapeHtml(`${w.label} ${s.name}: ${s.value.toFixed(1)}時間`)}"></rect>`;
        return r;
      });
    const total = totals[i];
    return `${rects.join("")}
      ${total ? `<text x="${cx}" y="${PAD_T + innerH - (total / max) * innerH - 5}" text-anchor="middle" font-size="10" fill="var(--ink-2)">${total.toFixed(0)}h</text>` : ""}
      <text x="${cx}" y="${H - 6}" text-anchor="middle" font-size="10" fill="var(--muted)">${escapeHtml(w.label)}</text>`;
  });
  const legendNames = [...new Set(weekData.flatMap((w) => w.segs.filter((s) => s.value > 0).map((s) => s.name)))];
  container.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="週別会議時間">
      ${grid.join("")}
      <line x1="${PAD_L}" y1="${PAD_T + innerH}" x2="${W - 4}" y2="${PAD_T + innerH}" stroke="var(--baseline)"></line>
      ${cols.join("")}
    </svg>
    <div class="chart-legend">${legendNames
      .map((n) => `<span class="key"><span class="swatch" style="background:${projColor(n)}"></span>${escapeHtml(n)}</span>`)
      .join("")}</div>`;
  bindTooltip(container.querySelector("svg"));
}

function renderWorkload() {
  const card1 = document.getElementById("workload-card");
  const card2 = document.getElementById("workload-weekly-card");
  const hasEvents = (state.data.calendar?.events || []).some(
    (e) => e.owner && e.owner.includes(PERSONS[0].owner)
  );
  card1.style.display = hasEvents ? "" : "none";
  card2.style.display = hasEvents ? "" : "none";
  if (!hasEvents) return;
  const { weeks, byWeek } = computeWorkload(4);
  // 今週（末尾の週）
  const thisWeek = byWeek.get(weeks[weeks.length - 1]);
  const rows = [...thisWeek.entries()]
    .map(([name, hours]) => ({ name, hours, color: projColor(name) }))
    .sort((a, b) => b.hours - a.hours);
  const total = rows.reduce((s, r) => s + r.hours, 0);
  document.getElementById("workload-total").textContent = total ? `合計 ${total.toFixed(1)}時間` : "";
  workloadBars(document.getElementById("workload-week"), rows);
  // 週別スタック
  const weekData = weeks.map((w) => ({
    label: `${Number(w.slice(5, 7))}/${Number(w.slice(8, 10))}週`,
    segs: [...byWeek.get(w).entries()]
      .map(([name, value]) => ({ name, value, color: projColor(name) }))
      .sort((a, b) => (a.name === "その他") - (b.name === "その他") || b.value - a.value),
  }));
  stackedColumns(document.getElementById("workload-weekly"), weekData);
}

/* ---------------- 概要タブ ---------------- */

const MATTER_MINI_COLUMNS = [
  { label: "案件名", render: (m) => `<span class="row-title">${escapeHtml(m["案件名"])}</span>` },
  { label: "ステータス", render: (m) => statusBadge(m["ステータス"]) },
];
const MEETING_MINI_COLUMNS = [
  { label: "日時", cls: "num", render: (m) => escapeHtml(fmtDate(m["日時"])) },
  { label: "会議名", render: (m) => `<span class="row-title">${escapeHtml(m["会議名"])}</span>` },
  { label: "種別", render: (m) => (m["会議種別"] ? `<span class="badge">${escapeHtml(m["会議種別"])}</span>` : "") },
];

// KPIタイルクリック時のインライン内訳（renderOverviewでstate.kpiCacheに保存された内容を使う）
function renderKpiDetail(key) {
  const c = state.kpiCache;
  const box = document.querySelector("#kpi-detail .kpi-detail-inner");
  if (!c || !box) return;
  if (key === "openTasks") renderTable(box, sortTasks(c.openTasks), TASK_COLUMNS, openTaskDetail);
  else if (key === "overdue") renderTable(box, sortTasks(c.overdue), TASK_COLUMNS, openTaskDetail);
  else if (key === "dueThisWeek") renderTable(box, sortTasks(c.dueThisWeek), TASK_COLUMNS, openTaskDetail);
  else if (key === "matters") renderTable(box, c.matters, MATTER_MINI_COLUMNS, openMatterDetail);
  else if (key === "recentMeetings") renderTable(box, sortMeetings(c.recentMeetings), MEETING_MINI_COLUMNS, openMeetingDetail);
}

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

  // KPIタイル（クリックでその場に内訳をインライン展開）
  state.kpiCache = { openTasks, overdue, dueThisWeek, matters, recentMeetings };
  const KPI_DEFS = [
    { key: "openTasks", label: "進行中タスク", value: openTasks.length, sub: `全${tasks.length}件中` },
    { key: "overdue", label: "⚠ 期限超過", value: overdue.length, sub: "対応が必要", critical: overdue.length > 0 },
    { key: "dueThisWeek", label: "今週期日", value: dueThisWeek.length, sub: "7日以内" },
    { key: "matters", label: "進行中案件", value: matters.length, sub: "案件ボード" },
    { key: "recentMeetings", label: "直近30日の会議", value: recentMeetings.length, sub: `議事録 全${meetings.length}件` },
  ];
  document.getElementById("kpi-row").innerHTML = KPI_DEFS.map(
    (k) => `<div class="kpi kpi-click ${k.critical ? "kpi-critical" : ""}" data-kpi="${k.key}">
        <div class="kpi-label">${escapeHtml(k.label)}</div>
        <div class="kpi-value">${k.value}</div>
        <div class="kpi-sub">${escapeHtml(k.sub)}</div>
      </div>`
  ).join("");
  const kpiDetail = document.getElementById("kpi-detail");
  document.querySelectorAll(".kpi-click").forEach((tile) => {
    tile.addEventListener("click", () => {
      const wasActive = tile.classList.contains("active");
      document.querySelectorAll(".kpi-click").forEach((t) => t.classList.remove("active"));
      if (wasActive) {
        kpiDetail.classList.remove("open");
        return;
      }
      tile.classList.add("active");
      kpiDetail.innerHTML = `<div><div class="kpi-detail-inner"></div></div>`;
      renderKpiDetail(tile.dataset.kpi);
      kpiDetail.classList.add("open");
    });
  });

  // 今週のフォーカス（タスクから自動生成。手書き分があれば下に併記）
  const manual = (meta.weeklyFocus || "")
    .replace(/^## 📌 今週のフォーカス\n?/, "")
    .replace(/^> ここに今週の重点事項を書く\n?/, "")
    .trim();
  document.getElementById("weekly-focus").innerHTML =
    renderMarkdown(meta.generatedFocus || manual) +
    (meta.generatedFocus && manual
      ? `<details class="focus-manual"><summary>Notionの手書きメモ</summary>${renderMarkdown(manual)}</details>`
      : "");

  // 今日の予定（Outlook予定があれば表示）
  const todayItems = state.data.calendar?.events?.length ? itemsForDay(todayStr()) : [];
  const todayCard = document.getElementById("today-card");
  if (todayItems.length) {
    todayCard.style.display = "";
    const todayList = document.getElementById("today-list");
    todayList.innerHTML = `<ul class="day-list">${todayItems
      .map((it) => {
        if (it.kind === "event") return eventItemHtml(it.ev, it.time || "終日");
        if (it.kind === "task")
          return `<li class="day-click" data-task-id="${escapeHtml(it.t.id)}"><span class="day-time">期日</span>✅ ${escapeHtml(it.title)}</li>`;
        return `<li class="day-click" data-meeting-id="${escapeHtml(it.m.id)}"><span class="day-time">MTG</span>📝 ${escapeHtml(it.title)}</li>`;
      })
      .join("")}</ul>`;
    todayList.querySelectorAll(".day-click").forEach((li) => {
      li.addEventListener("click", () => {
        if (li.dataset.taskId) {
          const t = tasks.find((x) => x.id === li.dataset.taskId);
          if (t) openTaskDetail(t);
        } else if (li.dataset.meetingId) {
          const m = meetings.find((x) => x.id === li.dataset.meetingId);
          if (m) openMeetingDetail(m);
        }
      });
    });
    bindEventAccordions(todayList);
  } else {
    todayCard.style.display = "none";
  }

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

  // 設定モーダル
  document.getElementById("settings-btn").addEventListener("click", openSettings);

  const metaBar = document.querySelector(".meta-bar");
  try {
    const names = ["matters", "tasks", "projects", "meetings", "knowledge", "meta", "calendar", "slack", "mail"];
    const EMPTY_FALLBACK = {
      calendar: { events: [] }, // 予定表は未生成でも動かす
      slack: { mentions: [], todosCreated: [] }, // Slack監視は未生成でも動かす
      mail: { items: [] }, // メール監視は未生成でも動かす
    };
    const raw = {};
    await Promise.all(
      names.map(async (n) => {
        try {
          raw[n] = await loadJson(n);
        } catch (e) {
          if (EMPTY_FALLBACK[n]) raw[n] = EMPTY_FALLBACK[n];
          else throw e;
        }
      })
    );
    state.data = await resolveData(raw);
    const meta = state.data.meta;
    const synced = new Date(meta.syncedAt);
    metaBar.innerHTML = `最終同期: ${synced.toLocaleString("ja-JP")}（3時間ごと自動）｜ ${meta.dashboardUrl ? `<a href="${escapeHtml(meta.dashboardUrl)}" target="_blank" rel="noopener">Notion ↗</a>` : ""}`;
  } catch (e) {
    console.error(e);
    metaBar.textContent = "同期データの読み込みに失敗しました。GitHub Actionsの実行状況を確認してください。";
    document.querySelector("main").innerHTML = `<div class="card"><div class="empty-state">データを読み込めませんでした。時間をおいて再読み込みしてください。</div></div>`;
    return;
  }

  rerenderAll();
  renderKnowledgeTab();
  activateTab(location.hash.slice(1) || "overview");
  setInterval(tickElapsed, 60000);
  if (typeof Notification !== "undefined" && Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
  checkUpcomingMeetings();
  setInterval(checkUpcomingMeetings, 20000);
}

/* ---------------- 設定モーダル ---------------- */

function openSettings() {
  const overlay = document.getElementById("settings-overlay");
  overlay.classList.add("open");
  const passInput = document.getElementById("setting-pass");
  const gasInput = document.getElementById("setting-gas");
  passInput.value = getPass();
  gasInput.value = localStorage.getItem("dash_gas_url") || "";
  gasInput.placeholder = state.data?.meta?.editEndpoint
    ? `既定: ${state.data.meta.editEndpoint.slice(0, 48)}…`
    : "https://script.google.com/macros/s/…/exec";
  const close = () => overlay.classList.remove("open");
  document.getElementById("settings-cancel").onclick = close;
  document.getElementById("settings-save").onclick = () => {
    if (passInput.value) localStorage.setItem("dash_pass", passInput.value);
    else localStorage.removeItem("dash_pass");
    if (gasInput.value) localStorage.setItem("dash_gas_url", gasInput.value.trim());
    else localStorage.removeItem("dash_gas_url");
    close();
    toast("設定を保存しました");
    location.reload();
  };
}

main();
