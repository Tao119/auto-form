/**
 * Google OAuth2 認証スクリプト
 * 実行: node scripts/auth-oauth2.js
 *
 * 初回のみブラウザが開きます。
 * tao.dama.art@gmail.com でログインして認証してください。
 * トークンは config/oauth2-token.json に保存されます。
 */
import 'dotenv/config'
import { google } from 'googleapis'
import fs from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'
import { exec } from 'child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOKEN_PATH = path.resolve(__dirname, '../config/oauth2-token.json')
const CREDS_PATH = path.resolve(__dirname, '../config/oauth2-credentials.json')

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file'
]

// OAuth2認証情報ファイルの確認
if (!fs.existsSync(CREDS_PATH)) {
  console.log('❌ config/oauth2-credentials.json が見つかりません')
  console.log('')
  console.log('GCC で OAuth2 クライアントIDを作成してください:')
  console.log('  1. GCC → APIとサービス → 認証情報')
  console.log('  2. 認証情報を作成 → OAuth クライアント ID')
  console.log('  3. アプリの種類: デスクトップアプリ')
  console.log('  4. JSONをダウンロード → config/oauth2-credentials.json として保存')
  process.exit(1)
}

const credentials = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'))
const { client_id, client_secret } = credentials.installed || credentials.web

const oauth2Client = new google.auth.OAuth2(
  client_id,
  client_secret,
  'http://localhost:3333/callback'
)

// 既存トークンがあれば使う
if (fs.existsSync(TOKEN_PATH)) {
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
  oauth2Client.setCredentials(token)
  console.log('✅ 既存トークンを使用します')
  await testConnection()
  process.exit(0)
}

// 認証URLを生成してブラウザを開く
const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  login_hint: process.env.SHEETS_OWNER_EMAIL,
  prompt: 'consent'
})

console.log('=== Google OAuth2 認証 ===')
console.log(`ログインアカウント: ${process.env.SHEETS_OWNER_EMAIL}`)
console.log('ブラウザを開いています...')

// macOS でブラウザを開く
exec(`open "${authUrl}"`, (err) => {
  if (err) {
    console.log('ブラウザが自動で開かない場合は以下のURLを開いてください:')
    console.log(authUrl)
  }
})

// コールバックサーバーを起動してコードを受け取る
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3333')
  const code = url.searchParams.get('code')

  if (!code) {
    res.writeHead(400)
    res.end('認証コードが見つかりません')
    return
  }

  try {
    const { tokens } = await oauth2Client.getToken(code)
    oauth2Client.setCredentials(tokens)

    // トークンを保存
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
    console.log('✅ 認証成功！トークンを保存しました')

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<h1>✅ 認証完了！このタブを閉じてください</h1>')

    server.close()
    await testConnection()
  } catch (err) {
    console.error('トークン取得エラー:', err.message)
    res.writeHead(500)
    res.end('エラーが発生しました')
    server.close()
  }
})

server.listen(3333, () => {
  console.log('認証待機中... (ブラウザでログインしてください)')
})

async function testConnection() {
  try {
    const sheets = google.sheets({ version: 'v4', auth: oauth2Client })
    const res = await sheets.spreadsheets.create({
      requestBody: { properties: { title: '企業リスト_テスト接続' } }
    })
    const id = res.data.spreadsheetId
    const url = res.data.spreadsheetUrl
    console.log('')
    console.log('✅ スプレッドシート作成テスト成功!')
    console.log('URL:', url)

    // 確認用に作ったものは削除
    const drive = google.drive({ version: 'v3', auth: oauth2Client })
    await drive.files.delete({ fileId: id })
    console.log('（テスト用のため削除済み）')
    console.log('')
    console.log('次のステップ: npm run init-sheets')
  } catch (e) {
    console.error('接続テストエラー:', e.message)
  }
}
