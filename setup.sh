#!/bin/bash
# ======================================
# リスト収集AI - セットアップスクリプト
# ======================================
set -e

echo "=== リスト収集AI セットアップ ==="

# Node.js バージョン確認
NODE_VERSION=$(node --version 2>/dev/null || echo "not found")
if [[ "$NODE_VERSION" == "not found" ]]; then
  echo "❌ Node.js がインストールされていません (v18+ 必要)"
  exit 1
fi
echo "✓ Node.js: $NODE_VERSION"

# 依存パッケージのインストール
echo ""
echo "📦 依存パッケージをインストール中..."
npm install

# .env ファイルの作成
if [ ! -f .env ]; then
  cp .env.example .env
  echo "✓ .env ファイルを作成しました"
  echo "⚠️  .env を編集してAPIキーを設定してください"
else
  echo "✓ .env ファイルは既に存在します"
fi

# logs ディレクトリの作成
mkdir -p logs
echo "✓ logs ディレクトリを作成しました"

# config/service-account.json の確認
if [ ! -f config/service-account.json ]; then
  echo ""
  echo "⚠️  Google サービスアカウントJSONが必要です"
  echo "   1. Google Cloud Console でサービスアカウントを作成"
  echo "   2. JSONキーをダウンロード"
  echo "   3. config/service-account.json として保存"
  echo "   4. サービスアカウントをスプレッドシートに共有"
fi

echo ""
echo "=== セットアップ完了 ==="
echo ""
echo "次のステップ:"
echo "1. .env を編集してAPIキーを設定"
echo "2. config/service-account.json を配置"
echo "3. config/search-params.json で検索条件を設定"
echo "4. npm start で実行"
echo ""
echo "n8nで実行する場合:"
echo "1. n8n/workflow.json をn8nにインポート"
echo "2. Google Sheets と OpenAI の認証情報を設定"
echo "3. 環境変数を n8n の Variables に設定"
