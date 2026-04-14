import { google } from 'googleapis'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import logger from '../utils/logger.js'
import searchParams from '../../config/search-params.json' with { type: 'json' }

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SHEET_NAME = process.env.GOOGLE_SHEETS_SHEET_NAME || '企業リスト'
const COLUMNS = searchParams.sheetsColumns

let sheetsClient = null
let driveClient = null

// 実行時にIDが決まる（自動作成 or 環境変数）
let resolvedSpreadsheetId = process.env.GOOGLE_SHEETS_ID || null

const OAUTH2_TOKEN_PATH = path.resolve(__dirname, '../../config/oauth2-token.json')
const OAUTH2_CREDS_PATH = path.resolve(__dirname, '../../config/oauth2-credentials.json')
const SERVICE_ACCOUNT_PATH = path.resolve(__dirname, '../../config/service-account.json')

// ===== 認証（OAuth2優先 → サービスアカウントフォールバック）=====

async function getAuth() {
  // OAuth2トークンがあればそちらを優先（スプシ作成に必要）
  if (fs.existsSync(OAUTH2_TOKEN_PATH) && fs.existsSync(OAUTH2_CREDS_PATH)) {
    const creds = JSON.parse(fs.readFileSync(OAUTH2_CREDS_PATH, 'utf-8'))
    const token = JSON.parse(fs.readFileSync(OAUTH2_TOKEN_PATH, 'utf-8'))
    const { client_id, client_secret } = creds.installed || creds.web
    const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3333/callback')
    oauth2Client.setCredentials(token)
    return oauth2Client
  }

  // フォールバック: サービスアカウント（書き込みのみ、スプシ新規作成は不可）
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error('config/oauth2-token.json または config/service-account.json が必要です')
  }
  const credentials = JSON.parse(fs.readFileSync(SERVICE_ACCOUNT_PATH, 'utf-8'))
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.file'
    ]
  })
}

async function getSheets() {
  if (sheetsClient) return sheetsClient
  sheetsClient = google.sheets({ version: 'v4', auth: await getAuth() })
  return sheetsClient
}

async function getDrive() {
  if (driveClient) return driveClient
  driveClient = google.drive({ version: 'v3', auth: await getAuth() })
  return driveClient
}

// ===== スプレッドシート自動作成 =====

/**
 * スプレッドシートを自動作成し、ヘッダー・フォーマットを設定する
 * 作成後に .env の GOOGLE_SHEETS_ID を自動更新する
 *
 * @param {Object} options
 * @param {string} [options.title] - スプレッドシートのタイトル
 * @param {string} [options.shareEmail] - 共有するGmailアドレス（閲覧・編集）
 * @returns {Promise<string>} spreadsheetId
 */
export async function createSpreadsheet({
  title = `企業リスト_${todayStr()}`,
  shareEmail = process.env.SHEETS_OWNER_EMAIL
} = {}) {
  const sheets = await getSheets()
  const headers = Object.values(COLUMNS)

  logger.info(`スプレッドシートを作成中: "${title}"`)

  // 1. スプレッドシートを作成
  const createRes = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title, locale: 'ja_JP', timeZone: 'Asia/Tokyo' },
      sheets: [
        {
          properties: {
            title: SHEET_NAME,
            gridProperties: { frozenRowCount: 1 } // ヘッダー行を固定
          }
        }
      ]
    }
  })

  const spreadsheetId = createRes.data.spreadsheetId
  const spreadsheetUrl = createRes.data.spreadsheetUrl
  const sheetId = createRes.data.sheets?.[0]?.properties?.sheetId ?? 0
  logger.info(`スプレッドシート作成完了: ${spreadsheetUrl}`)

  // 2. ヘッダー行を書き込み
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${SHEET_NAME}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [headers] }
  })

  // 3. ヘッダー行のフォーマット（太字・背景色・列幅）
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        // ヘッダー太字・背景色
        {
          repeatCell: {
            range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
            cell: {
              userEnteredFormat: {
                backgroundColor: { red: 0.2, green: 0.4, blue: 0.7 },
                textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 }, fontSize: 10 },
                horizontalAlignment: 'CENTER'
              }
            },
            fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)'
          }
        },
        // A列（会社名）幅
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
        // B列（HP URL）幅
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 250 }, fields: 'pixelSize' } },
        // C列（フォームURL）幅
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 250 }, fields: 'pixelSize' } },
        // D列（電話番号）幅
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 130 }, fields: 'pixelSize' } },
        // J列（収集日時）幅
        { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 9, endIndex: 10 }, properties: { pixelSize: 150 }, fields: 'pixelSize' } },
        // K列（ステータス）に条件付き書式（未送信＝赤、送信済み＝緑）
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '未送信' }] },
                format: { backgroundColor: { red: 1, green: 0.9, blue: 0.9 } }
              }
            },
            index: 0
          }
        },
        {
          addConditionalFormatRule: {
            rule: {
              ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
              booleanRule: {
                condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '送信済み' }] },
                format: { backgroundColor: { red: 0.85, green: 0.95, blue: 0.85 } }
              }
            },
            index: 1
          }
        }
      ]
    }
  })

  // 4. 共有（shareEmailが設定されている場合）
  if (shareEmail) {
    await shareSpreadsheet(spreadsheetId, shareEmail)
  } else {
    logger.warn('SHEETS_OWNER_EMAIL 未設定のためスプシ共有をスキップ。サービスアカウントのメールで直接アクセスするか、手動で共有してください')
  }

  // 5. .env に GOOGLE_SHEETS_ID を自動書き込み
  saveSpreadsheetIdToEnv(spreadsheetId)

  resolvedSpreadsheetId = spreadsheetId
  logger.info(`✅ スプレッドシートID: ${spreadsheetId}`)
  logger.info(`✅ URL: ${spreadsheetUrl}`)

  return spreadsheetId
}

/**
 * スプレッドシートを指定メールアドレスに共有
 */
async function shareSpreadsheet(spreadsheetId, email) {
  const drive = await getDrive()
  try {
    await drive.permissions.create({
      fileId: spreadsheetId,
      requestBody: {
        type: 'user',
        role: 'writer',
        emailAddress: email
      },
      sendNotificationEmail: false
    })
    logger.info(`✅ スプレッドシートを共有: ${email}`)
  } catch (error) {
    logger.warn(`スプレッドシート共有失敗（手動で共有してください）: ${error.message}`)
  }
}

/**
 * .env ファイルに GOOGLE_SHEETS_ID を書き込む
 */
function saveSpreadsheetIdToEnv(spreadsheetId) {
  const envPath = path.resolve(__dirname, '../../.env')
  if (!fs.existsSync(envPath)) return

  let content = fs.readFileSync(envPath, 'utf-8')

  if (/^GOOGLE_SHEETS_ID=/m.test(content)) {
    content = content.replace(/^GOOGLE_SHEETS_ID=.*/m, `GOOGLE_SHEETS_ID=${spreadsheetId}`)
  } else {
    content += `\nGOOGLE_SHEETS_ID=${spreadsheetId}\n`
  }

  fs.writeFileSync(envPath, content)
  logger.info('.env に GOOGLE_SHEETS_ID を保存しました')
}

// ===== 既存スプシ操作 =====

/**
 * 初期化：スプシIDが未設定なら自動作成、設定済みならヘッダー確認
 * @returns {Promise<string>} spreadsheetId
 */
export async function initializeSheet() {
  if (!resolvedSpreadsheetId) {
    logger.info('GOOGLE_SHEETS_ID 未設定 → スプレッドシートを自動作成します')
    return createSpreadsheet()
  }

  const sheets = await getSheets()
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: resolvedSpreadsheetId,
    range: `${SHEET_NAME}!A1:L1`
  })

  if (!response.data.values || response.data.values.length === 0) {
    const headers = Object.values(COLUMNS)
    await sheets.spreadsheets.values.update({
      spreadsheetId: resolvedSpreadsheetId,
      range: `${SHEET_NAME}!A1`,
      valueInputOption: 'RAW',
      requestBody: { values: [headers] }
    })
    logger.info('ヘッダー行を初期化しました')
  } else {
    logger.info('ヘッダー行は既に存在します')
  }

  return resolvedSpreadsheetId
}

export async function getExistingUrls() {
  if (!resolvedSpreadsheetId) return new Set()

  const sheets = await getSheets()
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: resolvedSpreadsheetId,
      range: `${SHEET_NAME}!B2:B`
    })
    const rows = response.data.values || []
    const urls = new Set(
      rows.flat().filter(Boolean).map(normalizeSheetUrl)
    )
    logger.info(`既存データ: ${urls.size}件`)
    return urls
  } catch (error) {
    logger.error('既存データ取得エラー', { error: error.message })
    return new Set()
  }
}

export async function appendCompanies(companies) {
  if (companies.length === 0 || !resolvedSpreadsheetId) return { written: 0 }

  const sheets = await getSheets()
  const now = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })

  const rows = companies.map((c) => [
    c.name || '',
    c.url || '',
    c.formUrl || '',
    c.phone || '',
    c.email || '',
    c.address || '',
    c.industry || '',
    c.area || '',
    c.formType || '',
    now,
    c.status || '未送信',
    c.notes || ''
  ])

  await sheets.spreadsheets.values.append({
    spreadsheetId: resolvedSpreadsheetId,
    range: `${SHEET_NAME}!A:L`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows }
  })

  logger.info(`スプレッドシートに ${companies.length} 件書き込みました`)
  return { written: companies.length }
}

export async function appendCompany(company) {
  return appendCompanies([company])
}

export function getSpreadsheetId() {
  return resolvedSpreadsheetId
}

// ===== ユーティリティ =====

function normalizeSheetUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return url.toLowerCase().trim()
  }
}

function todayStr() {
  return new Date().toLocaleDateString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).replace(/\//g, '')
}
