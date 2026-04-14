/**
 * スプレッドシート単独初期化スクリプト
 * node scripts/init-sheets.js で実行
 *
 * サービスアカウントJSONだけあれば実行できます。
 * 実行後に .env の GOOGLE_SHEETS_ID が自動更新されます。
 */
import 'dotenv/config'
import { createSpreadsheet } from '../src/sheets/sheets-client.js'

const title = process.argv[2] || `企業リスト_${new Date().toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }).replace(/\//g, '')}`
const shareEmail = process.env.SHEETS_OWNER_EMAIL

console.log('=== スプレッドシート自動作成 ===')
if (shareEmail) {
  console.log(`共有先: ${shareEmail}`)
} else {
  console.log('⚠️  SHEETS_OWNER_EMAIL 未設定 - 共有なしで作成します')
}

try {
  const id = await createSpreadsheet({ title, shareEmail })
  console.log('\n✅ 完了')
  console.log(`ID:  ${id}`)
  console.log(`URL: https://docs.google.com/spreadsheets/d/${id}/edit`)
  console.log('\n.env の GOOGLE_SHEETS_ID に自動保存しました')
} catch (error) {
  console.error('❌ エラー:', error.message)
  process.exit(1)
}
