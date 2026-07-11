# 板橋 ダッシュボード

Notionをデータベースとして使いつつ、閲覧・編集を1つのWebページで完結させるダッシュボード。
https://andcokey.github.io/my_dashboard/index.html

## できること

- **タブ**: 概要 / For me / For 西山副社長 / 予定表 / 進行中案件 / TODO / プロジェクト / 議事録 / ナレッジ
- **概要**: KPIタイル・今週のフォーカス（タスクから自動生成）・今日の予定・各種チャート
- **For me / For 西山副社長**: 本人のOutlook予定（直近7日）＋関連タスク・案件・議事録
- **予定表**: 月カレンダー（Outlook予定・タスク期日・議事録を重ね表示）＋タスクタイムライン
- **編集**: タスク・案件・プロジェクトのステータス／優先度／期日／メモを詳細画面から直接変更、新規タスク作成、削除（Notionのゴミ箱へ移動） → GAS経由でNotionに即時反映
- **工数**: 自分のOutlook予定を案件別に分類し、今週の会議時間（概要）と直近4週の週別スタック（予定表）を表示
- **保護**: データはAES-256-GCMで暗号化して配信。閲覧には合言葉が必要（初回入力後ブラウザが記憶）

## 構成

```
sync/fetch-notion.js        Notion→JSON同期（本文込み）、フォーカス自動生成、予定表統合、暗号化
sync/crypto.js              暗号化ユーティリティ（Web側と同フォーマット）
sync/ics.js                 Outlook公開ICSのパーサ（自動同期用・任意）
sync/encrypt-snapshot.js    Claude(MCP)が取得した予定表スナップショットの暗号化
sync/calendar-snapshot.enc.json  暗号化済み予定表スナップショット（コミット対象）
gas/Code.gs                 編集プロキシ（Google Apps Script、Notionへの書き込み担当）
web/                        タブ型SPA本体
.github/workflows/deploy.yml  push時＋3時間ごと＋手動でPagesへデプロイ
```

## セットアップ（初回のみ）

### 1. サイトの合言葉

1. リポジトリの Settings > Secrets and variables > Actions > **Secrets** に `SITE_PASSWORD` を登録
2. 同じ文字列をサイト閲覧時の合言葉として使う（初回アクセス時に入力）

### 2. 編集プロキシ（GAS）

1. https://script.google.com で新規プロジェクト作成、`gas/Code.gs` の中身を貼り付け
2. プロジェクトの設定 > スクリプト プロパティに以下を追加
   - `NOTION_TOKEN`: GitHub Secretsに登録済みのNotionトークンと同じもの
   - `SHARED_TOKEN`: `SITE_PASSWORD` と同じ文字列
3. デプロイ > 新しいデプロイ > ウェブアプリ（実行ユーザー: 自分／アクセス: 全員）
4. 発行されたURL（`https://script.google.com/macros/s/…/exec`）を
   Settings > Secrets and variables > Actions > **Variables** に `GAS_ENDPOINT` として登録
   （またはサイトの⚙設定に直接貼り付け）

### 3. Outlook予定表

方法A（Claude/MCP・推奨）: 毎朝07:48にWindowsタスクスケジューラ「DashboardCalendarUpdate」が
`%USERPROFILE%\.claude\scripts\update-dashboard-calendar.ps1` を実行し、Claude Codeヘッドレスが
Outlook予定を取得→暗号化→push する（PCが起動していなければ次回起動時に実行）。
手動更新はClaude Codeに「予定表を更新して」と頼めばよい。
ログ: `%USERPROFILE%\.claude\logs\dashboard-calendar.log`

方法B（ICS・全自動）: Outlook on the web > 設定 > 予定表 > 共有予定表 > 「予定表の公開」でICS URLを発行し、
Secrets に `CALENDAR_ICS` を登録:
```json
[{"name":"板橋","url":"https://outlook.office365.com/owa/calendar/..../calendar.ics"}]
```

## 予定表の更新（方法A）の内部フロー

1. Claude が MCP で Outlook イベントを取得し、平文JSONを一時ディレクトリに書く
2. `SITE_PASSWORD=xxx node sync/encrypt-snapshot.js <events.json>` で `sync/calendar-snapshot.enc.json` を生成
3. コミット＆push → Actions が復号・マージして `web/data/calendar.json`（暗号化）として配信

## Notion側の構成が変わったとき

`sync/fetch-notion.js` 冒頭の `SOURCES` / `KNOWLEDGE_PAGE_ID` / `DASHBOARD_ROOT_PAGE_ID` を更新。
プロパティ名（日本語カラム名）が変わった場合は `web/assets/app.js` 側の参照も合わせて修正する。

## セキュリティメモ

- リポジトリは公開だが、業務データ（`web/data/*.json`・予定表スナップショット）はすべて `SITE_PASSWORD` で暗号化されている
- GASのURLが知られても `SHARED_TOKEN`（合言葉）がなければ書き込みできない
- 合言葉を変える場合: GitHub Secrets / GASのSHARED_TOKEN / 閲覧者のブラウザ（⚙設定）の3か所を更新
