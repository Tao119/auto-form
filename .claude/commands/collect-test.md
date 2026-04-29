# collect-test — 収集テスト実行

指定した業種・エリアで収集テストを実行し、件数とコストを計測する。

## 使い方

```
/collect-test [業種] [エリア]
```

例:
- `/collect-test 美容室 東京都`
- `/collect-test 歯科医院 大阪府`
- 引数省略時は `美容室 東京都` で実行

## 手順

1. **新規プロジェクト作成**（テスト専用）
   ```bash
   TS=$(date +%s)
   curl -s -X POST http://localhost:3000/api/projects \
     -H "Content-Type: application/json" \
     -d "{\"name\":\"収集テスト $(date '+%Y-%m-%d %H:%M') [$1 $2]\",\"description\":\"自動テスト\"}"
   ```

2. **Serper残高を記録**
   ```bash
   curl -s "https://google.serper.dev/account" -H "X-API-KEY: $SERPER_API_KEY"
   ```

3. **収集ジョブ投入**（maxResults=0 で無制限、Serperモード）
   ```bash
   TS=$(date +%s)
   curl -s -X POST http://localhost:3000/api/queue/execute \
     -H "Content-Type: application/json" \
     -d "{
       \"runId\": \"run-test-${TS}\",
       \"projectId\": \"<新規PJ_ID>\",
       \"label\": \"収集テスト $1 $2\",
       \"industry\": \"$1\",
       \"area\": \"$2\",
       \"keywords\": [\"$1\"],
       \"maxResults\": 0,
       \"searchProvider\": \"serper\"
     }"
   ```

4. **完了まで監視**（30秒ごとにキューをポーリング）

5. **結果レポート**
   - 収集件数
   - 消費クレジット数とコスト（$）
   - 1件あたりコスト
   - 全国47都道府県スケール時の推定コスト

## デフォルト値
- 業種: 美容室
- エリア: 東京都
