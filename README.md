# 板橋 ダッシュボード（Viewer）

Notionで管理している「板橋 ダッシュボード」の基幹部分（進行中案件・TODO・プロジェクト管理・議事録・ナレッジベース）を、**読み取り専用**の軽量Webビューアとして表示するための静的サイトです。

- データの実体は **Notionのまま**（このリポジトリではデータを保持しない）
- GitHub Actionsが3時間ごと（＋手動実行）にNotion APIからデータを取得し、GitHub Pagesへ静的サイトとして配信
- Slackメンション/メール案件/政治家・重要人物ニュース追跡/ストック週次分析などは対象外（Notion側にそのまま残る）

## 構成

```
sync/fetch-notion.js   Notion APIから5データソースを取得しweb/data/*.jsonを生成するスクリプト
web/                    GitHub Pagesとして配信する静的サイト本体（index.html, matters.html, ...）
.github/workflows/deploy.yml  定期実行＋Pagesデプロイ
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
