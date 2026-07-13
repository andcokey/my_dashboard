# 板橋 ダッシュボード

Notionをデータベースとして使いつつ、閲覧・編集を1つのWebページで完結させるダッシュボード。
https://andcokey.github.io/my_dashboard/index.html

## できること

- **タブ**: 概要 / For me / For 西山副社長 / 予定表 / 返信管理 / 進行中案件 / TODO / プロジェクト / 議事録 / ナレッジ
- **概要**: KPIタイル・今週のフォーカス（タスクから自動生成）・今日の予定・返信待ちミニカード・各種チャート
- **For me / For 西山副社長**: 本人のOutlook予定（直近7日）＋関連タスク・案件・議事録
- **予定表**: 月カレンダー（Outlook予定・タスク期日・議事録を重ね表示）＋タスクタイムライン。予定をクリックするとページ遷移なしでその場に展開し、場所・本文・Zoom等の参加リンクを表示
- **返信管理**: Slackの未返信メンションとOutlookの未返信メールを一覧表示（経過時間は1分ごとに自動更新）。Slackで `:todo_itabashi3:` スタンプを押したメッセージは自動でNotion TODOに追加（期日は当日23:59・ダッシュボードの編集フォームから日付・時刻とも変更可能）
- **編集**: タスク・案件・プロジェクトのステータス／優先度／期日（日付＋任意で時刻）／メモを詳細画面から直接変更、新規タスク作成、削除（Notionのゴミ箱へ移動） → GAS経由でNotionに即時反映
- **工数**: 自分のOutlook予定を案件別に分類し、今週の会議時間（概要）と直近4週の週別スタック（予定表）を表示
- **保護**: データはAES-256-GCMで暗号化して配信。閲覧には合言葉が必要（初回入力後ブラウザが記憶）

## 構成

```
sync/fetch-notion.js        Notion→JSON同期（本文込み）、フォーカス自動生成、予定表統合、暗号化
sync/crypto.js              暗号化ユーティリティ（Web側と同フォーマット）
sync/ics.js                 Outlook公開ICSのパーサ（自動同期用・任意）
sync/encrypt-snapshot.js    Claude(MCP)が取得したスナップショット（予定表/Slack/メール）の暗号化
sync/calendar-snapshot.enc.json  暗号化済み予定表スナップショット（コミット対象）
sync/slack-snapshot.enc.json     暗号化済みSlack監視スナップショット（コミット対象）
sync/mail-snapshot.enc.json      暗号化済みメール監視スナップショット（コミット対象）
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
2. `SITE_PASSWORD=xxx node sync/encrypt-snapshot.js <events.json> calendar` で `sync/calendar-snapshot.enc.json` を生成
3. コミット＆push → Actions が復号・マージして `web/data/calendar.json`（暗号化）として配信

## 返信管理（Slack監視・メール監視）

Windowsタスクスケジューラで1時間ごとに自動実行（PCが起動していなければ次回起動時に実行）:

- 「DashboardSlackUpdate」→ `%USERPROFILE%\.claude\scripts\update-dashboard-slack.ps1`
  - Slack MCPで自分宛メンション・DMを取得し、返信済みかどうかを判定
  - `:todo_itabashi3:` スタンプが付いたメッセージをNotion MCPで直接TODOデータベースに登録（期日=当日23:59 JST）、登録後は自分から `:white_check_mark:` を付けて重複登録を防止
  - `SITE_PASSWORD=xxx node sync/encrypt-snapshot.js <data.json> slack` で `sync/slack-snapshot.enc.json` を更新してpush
- 「DashboardMailUpdate」→ `%USERPROFILE%\.claude\scripts\update-dashboard-mail.ps1`
  - Microsoft 365 MCPで対象メールボックス（現在は koki-itabashi@group.gmo のみ）の受信メールを取得し、自動送信・メルマガを除外した上でSent Itemsとの照合で未返信を判定
  - `SITE_PASSWORD=xxx node sync/encrypt-snapshot.js <data.json> mail` で `sync/mail-snapshot.enc.json` を更新してpush

ログ: `%USERPROFILE%\.claude\logs\dashboard-slack.log` / `dashboard-mail.log`

西山さん秘書用のメールボックス（nishiyama-sec@gmo.jp・正しいアドレスと確認済みだがGraph APIで
`MailboxNotEnabledForRESTAPI`＝無効化/削除済みまたはオンプレミスExchangeでREST API非対応というエラーとなり保留中。
情報システム部門への確認待ち）が解決したら、
`update-dashboard-mail.ps1` 内の「対象メールボックス」リストに追加し、`mailboxOwnerEmail` 指定での検索手順を増やすこと。

## Notion側の構成が変わったとき

`sync/fetch-notion.js` 冒頭の `SOURCES` / `KNOWLEDGE_PAGE_ID` / `DASHBOARD_ROOT_PAGE_ID` を更新。
プロパティ名（日本語カラム名）が変わった場合は `web/assets/app.js` 側の参照も合わせて修正する。

## セキュリティメモ

- リポジトリは公開だが、業務データ（`web/data/*.json`・予定表スナップショット）はすべて `SITE_PASSWORD` で暗号化されている
- GASのURLが知られても `SHARED_TOKEN`（合言葉）がなければ書き込みできない
- 合言葉を変える場合: GitHub Secrets / GASのSHARED_TOKEN / 閲覧者のブラウザ（⚙設定）の3か所を更新
