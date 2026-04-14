# 企業フォーム自動収集ツール

Google Places API で企業を検索し、各社ウェブサイトからお問い合わせフォームのURLを自動収集するシステムです。収集結果はGoogle スプレッドシートに書き込まれ、ブラウザから確認・CSV出力できます。

## システム構成

| コンポーネント | 役割 |
|---|---|
| **Next.js (web)** | ダッシュボードUI・APIサーバー |
| **n8n** | 検索・スクレイピング・AI判定のワークフロー実行エンジン |
| **Playwright Service** | フォーム送信用ブラウザ自動化サービス |
| **Google Places API** | 企業リスト取得 |
| **OpenAI GPT-4o-mini** | フォーム種別（問い合わせ vs 予約）の自動判定 |
| **Google Sheets** | 収集結果の永続ストレージ |

### 処理フロー

```
[ダッシュボード] → [n8n webhook]
  → L-01: 検索パラメータ設定
  → L-02: Google Places API で企業リスト取得（エリア細分化・全ページ収集）
  → L-03: 各社HP取得・フォームリンク抽出（Cheerio）
  → L-04: GPT によるフォーム種別判定（問い合わせ/予約/不明）
  → L-05: 重複チェック（既存シートと照合）
  → L-06: Google Sheets に書き込み
  → 完了コールバック → UI のステータス更新
```

## セットアップ

### 必要なもの

- Docker / Docker Compose
- Google Cloud プロジェクト（Places API・Sheets API 有効化済み）
- OpenAI API キー
- Google サービスアカウント（Sheets 書き込み権限）

### 手順

**1. リポジトリをクローン**

```bash
git clone https://github.com/tao119/auto-form.git
cd auto-form
```

**2. 環境変数を設定**

```bash
cp .env.example .env
```

`.env` を開いて以下を記入します。

| 変数名 | 説明 |
|---|---|
| `GOOGLE_MAPS_API_KEY` | Places API が有効なGoogle APIキー |
| `OPENAI_API_KEY` | OpenAI APIキー |
| `GOOGLE_SHEETS_ID` | 収集先スプレッドシートID（空白で自動作成） |
| `SHEETS_OWNER_EMAIL` | スプレッドシートを共有するGmailアドレス |
| `N8N_API_KEY` | n8n 起動後に発行するAPIキー（後述） |
| `N8N_WORKFLOW_ID` | n8n にインポートしたワークフローID（後述） |

**3. Google サービスアカウントを配置**

サービスアカウントのJSONキーファイルを `config/service-account.json` に置きます。

**4. コンテナを起動**

```bash
docker compose up -d
```

初回起動後、以下のURLにアクセスします。

| サービス | URL |
|---|---|
| ダッシュボード | http://localhost:3000 |
| n8n | http://localhost:5678 |

**5. n8n の初期設定**

1. http://localhost:5678 にアクセスしてアカウントを作成
2. 設定 → API Keys から APIキーを発行し、`.env` の `N8N_API_KEY` に記入
3. ワークフローを手動でインポート（`n8n/workflow.json`）するか、後述のスクリプトで自動デプロイ

n8n のワークフロー内で使用する環境変数（`GOOGLE_MAPS_API_KEY`、`OPENAI_API_KEY` など）は、n8n の Variables 設定で登録するか、`docker-compose.yml` の `environment` 経由で渡します。

**6. ワークフローのデプロイ（自動）**

```bash
# n8n起動後に実行
N8N_API_KEY=<your_key> N8N_WORKFLOW_ID=<wf_id> python3 - <<'EOF'
import urllib.request, json, os

N8N_BASE_URL = "http://localhost:5678"
N8N_API_KEY  = os.environ["N8N_API_KEY"]
WF_ID        = os.environ["N8N_WORKFLOW_ID"]
headers      = {"X-N8N-API-KEY": N8N_API_KEY, "Content-Type": "application/json; charset=utf-8"}

with open("n8n/workflow.json") as f:
    payload = json.dumps(
        {k: v for k, v in json.load(f).items()
         if k in {"name","nodes","connections","settings","staticData","pinData"}},
        ensure_ascii=False
    ).encode()

req = urllib.request.Request(f"{N8N_BASE_URL}/api/v1/workflows/{WF_ID}",
                             data=payload, method="PUT", headers=headers)
with urllib.request.urlopen(req) as r:
    print(f"PUT {r.status}")

req = urllib.request.Request(f"{N8N_BASE_URL}/api/v1/workflows/{WF_ID}/activate",
                             method="POST", headers=headers)
with urllib.request.urlopen(req) as r:
    print(f"Activate {r.status}")
EOF
```

## ローカル開発

```bash
cd web
cp .env.local.example .env.local   # APIキー等を記入
npm install
npm run dev
```

開発サーバーは `http://localhost:3000` で起動します（ポート変更時は `PORT=3003 npm run dev`）。

### 型チェック

```bash
cd web
npx tsc --noEmit
```

### ビルド確認

```bash
cd web
npm run build
```

## 使い方

1. ダッシュボードを開く（http://localhost:3000/dashboard）
2. 「新規プロジェクト」でプロジェクトを作成
3. 業種とエリアを選択して「実行開始」
4. 実行中は収集件数がリアルタイムで更新される
5. 完了後、実行履歴ページで収集件数と変換率を確認
6. プロジェクトページからCSVでダウンロード

### 変換率について

実行履歴の「収集件数」列に `N件中 X%` の形式で変換率が表示されます。

- N件 = Google Places API が返した企業の総数
- X% = そのうちフォームが見つかって実際に収集できた割合

## 注意事項

- Google Places API は1クエリあたり最大60件（3ページ×20件）の制限があります。エリア細分化により1回の実行で最大数千件の検索を行います。
- 大規模実行（全国・複数業種など）は相応の API 費用と実行時間が必要です。
- `.env` および `config/service-account.json` には機密情報が含まれるためリポジトリに含めないでください。

## ディレクトリ構成

```
auto-form/
├── web/                    # Next.js アプリ
│   ├── app/                # ページ・APIルート
│   ├── components/         # UIコンポーネント
│   └── lib/                # ビジネスロジック・型定義
├── n8n/                    # n8n ワークフロー定義
├── playwright-service/     # フォーム送信サービス
├── config/                 # 設定ファイル（service-account.json 等）
├── scripts/                # ユーティリティスクリプト
├── docker-compose.yml
└── .env.example
```
