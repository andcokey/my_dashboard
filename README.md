# 板橋 ダッシュボード

Notionで管理している「板橋 ダッシュボード」の基幹部分（進行中案件・TODO・プロジェクト管理・議事録・ナレッジベース）を、**読み取り専用**のダッシュボードとして1ページで俯瞰できる静的サイトです。

- `index.html` のタブ型SPA。概要タブにKPIタイル・タスクステータス構成・会議アクティビティ・プロジェクト別タスクのチャートを表示し、各タブで一覧＋クリックで詳細ドロワー（Notionページ本文込み）を閲覧できる
- 各ページの**本文もNotionから同期**するため、通常の閲覧はサイト内で完結する（編集のみNotion側）
- GitHub Actionsが3時間ごと・mainへのpush時・手動実行でNotion APIからデータを取得し、GitHub Pagesへ配信
- Slackメンション/メール案件/政治家・重要人物ニュース追跡/ストック週次分析などは対象外（Notion側にそのまま残る）

## 構成

```
sync/fetch-notion.js   Notion APIから5データソース＋各ページ本文を取得しweb/data/*.jsonを生成するスクリプト
web/index.html          タブ型SPA本体（matters.html等の旧ページはindex.htmlへのリダイレクト）
web/assets/app.js       KPI・チャート・一覧・詳細ドロワーの描画ロジック
.github/workflows/deploy.yml  push時＋定期実行＋手動実行でPagesデプロイ
```

## セットアップ手順

### 1. Notion Integrationを作成

1. https://www.notion.so/my-integrations で新規Internal Integrationを作成し、Tokenをコピー
2. 対象の5つのデータソース（📁 進行中案件 / ✅ TODO / プロジェクト管理 / 議事録 / 📚 ナレッジベース）それぞれで「•••」→「Connections」から作成したIntegrationを接続（Connect）

### 2. GitHubリポジトリの準備

1. このディレクトリをprivateリポジトリとしてGitHubにpush
2. リポジトリの Settings > Secrets and variables > Actions で `NOTION_TOKEN` を登録（手順1で取得したトークン）
3. Settings > Pages で Source を **GitHub Actions** に設定
4. private repoでPagesを公開するには GitHub Pro（個人）または Team/Enterprise（Organization）が必要。プランを確認のうえ、必要なら変更する

### 3. 動作確認（ローカル）

```bash
npm install
NOTION_TOKEN=xxxxx npm run sync   # web/data/*.json が生成される
npx serve web                      # または python -m http.server 8080 --directory web
```

生成された `web/data/*.json` の中身と、実際のNotionの内容を見比べて問題ないか確認してください。

### 4. デプロイ

`main` にpushするか、Actionsタブから `Sync Notion & Deploy Pages` を手動実行（workflow_dispatch）すると、Notionから最新データを取得してPagesへデプロイされます。以降は3時間ごとに自動実行されます。

## Notion側の構成が変わったとき

`sync/fetch-notion.js` 冒頭の `SOURCES` / `KNOWLEDGE_PAGE_ID` / `DASHBOARD_ROOT_PAGE_ID` にデータソースIDを直書きしています。Notion側でデータベースを作り直した場合はここを更新してください。プロパティ名（日本語のカラム名）が変わった場合は、同ファイル内の該当箇所と `web/*.html` 側のカラム参照も合わせて修正が必要です。

## 対象外にしているデータ（Notionに残るもの）

Slackメンション / メール案件 / 政治家・重要人物ニュース追跡 / 朝のニュースブリーフィング / 政界ブリーフィング / ストック週次分析 / Summit Half コンパス

これらはSlack Bot・メール取込・AI自動レポート生成という別レイヤーの自動化に依存しており、機密性も高いため今回のビューアには含めていません。必要になったら追加のデータソースとして同じ方式で拡張できます。
