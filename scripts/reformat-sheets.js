/**
 * 既存スプレッドシートのフォーマットを強化する
 * node scripts/reformat-sheets.js
 */
import 'dotenv/config'
import { google } from 'googleapis'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const TOKEN_PATH = path.resolve(__dirname, '../config/oauth2-token.json')
const CREDS_PATH = path.resolve(__dirname, '../config/oauth2-credentials.json')

const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'))
const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
const { client_id, client_secret } = creds.installed || creds.web
const oauth2Client = new google.auth.OAuth2(client_id, client_secret, 'http://localhost:3333/callback')
oauth2Client.setCredentials(token)

const sheets = google.sheets({ version: 'v4', auth: oauth2Client })
const spreadsheetId = process.env.GOOGLE_SHEETS_ID
const SHEET_NAME = process.env.GOOGLE_SHEETS_SHEET_NAME || '企業リスト'

if (!spreadsheetId) {
  console.error('GOOGLE_SHEETS_ID が未設定です')
  process.exit(1)
}

// シートIDを取得
const meta = await sheets.spreadsheets.get({ spreadsheetId })
const sheetId = meta.data.sheets.find(s => s.properties.title === SHEET_NAME)?.properties.sheetId ?? 0

console.log(`対象: ${spreadsheetId} (sheetId: ${sheetId})`)

await sheets.spreadsheets.batchUpdate({
  spreadsheetId,
  requestBody: {
    requests: [
      // ① ヘッダー行（行1）：濃い背景・白太字・中央
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.13, green: 0.18, blue: 0.32 },
              textFormat: {
                bold: true,
                foregroundColor: { red: 1, green: 1, blue: 1 },
                fontSize: 10
              },
              horizontalAlignment: 'CENTER',
              verticalAlignment: 'MIDDLE',
              wrapStrategy: 'CLIP'
            }
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)'
        }
      },
      // ② データ行（行2〜）：フォント・折り返し・左揃え
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 10000 },
          cell: {
            userEnteredFormat: {
              textFormat: { fontSize: 11 },
              verticalAlignment: 'MIDDLE',
              wrapStrategy: 'CLIP'
            }
          },
          fields: 'userEnteredFormat(textFormat,verticalAlignment,wrapStrategy)'
        }
      },
      // ③ バンディング（縞模様）
      {
        addBanding: {
          bandedRange: {
            bandedRangeId: 1,
            range: { sheetId, startRowIndex: 1, endRowIndex: 10000, startColumnIndex: 0, endColumnIndex: 12 },
            rowProperties: {
              headerColor: { red: 0.13, green: 0.18, blue: 0.32 },
              firstBandColor: { red: 1, green: 1, blue: 1 },
              secondBandColor: { red: 0.97, green: 0.98, blue: 1.0 }
            }
          }
        }
      },
      // ④ A列（会社名）幅 220px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 1 }, properties: { pixelSize: 220 }, fields: 'pixelSize' } },
      // ⑤ B列（HP URL）幅 280px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 1, endIndex: 2 }, properties: { pixelSize: 280 }, fields: 'pixelSize' } },
      // ⑥ C列（フォームURL）幅 280px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 2, endIndex: 3 }, properties: { pixelSize: 280 }, fields: 'pixelSize' } },
      // ⑦ D列（電話番号）幅 140px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
      // ⑧ E列（メール）幅 200px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 4, endIndex: 5 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
      // ⑨ F列（住所）幅 240px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 }, properties: { pixelSize: 240 }, fields: 'pixelSize' } },
      // ⑩ G列（業種）幅 140px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 }, properties: { pixelSize: 140 }, fields: 'pixelSize' } },
      // ⑪ H列（エリア）幅 100px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 8 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } },
      // ⑫ I列（フォーム種別）幅 120px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 8, endIndex: 9 }, properties: { pixelSize: 120 }, fields: 'pixelSize' } },
      // ⑬ J列（収集日時）幅 160px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 9, endIndex: 10 }, properties: { pixelSize: 160 }, fields: 'pixelSize' } },
      // ⑭ K列（ステータス）幅 100px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 10, endIndex: 11 }, properties: { pixelSize: 100 }, fields: 'pixelSize' } },
      // ⑮ L列（備考）幅 200px
      { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 11, endIndex: 12 }, properties: { pixelSize: 200 }, fields: 'pixelSize' } },
      // ⑯ 行の高さを28pxに統一
      {
        updateDimensionProperties: {
          range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 10000 },
          properties: { pixelSize: 28 },
          fields: 'pixelSize'
        }
      },
      // ⑰ K列（ステータス）にドロップダウン検証
      {
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 10000, startColumnIndex: 10, endColumnIndex: 11 },
          rule: {
            condition: {
              type: 'ONE_OF_LIST',
              values: [
                { userEnteredValue: '未送信' },
                { userEnteredValue: '送信済み' },
                { userEnteredValue: 'エラー' },
                { userEnteredValue: 'スキップ' },
                { userEnteredValue: '確認中' }
              ]
            },
            showCustomUi: true,
            strict: false
          }
        }
      },
      // ⑱ K列 条件付き書式 - 未送信（オレンジ）
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '未送信' }] },
              format: {
                backgroundColor: { red: 1.0, green: 0.93, blue: 0.80 },
                textFormat: { foregroundColor: { red: 0.6, green: 0.35, blue: 0.0 }, bold: true }
              }
            }
          },
          index: 0
        }
      },
      // ⑲ K列 条件付き書式 - 送信済み（緑）
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: '送信済み' }] },
              format: {
                backgroundColor: { red: 0.85, green: 0.96, blue: 0.87 },
                textFormat: { foregroundColor: { red: 0.1, green: 0.5, blue: 0.2 }, bold: true }
              }
            }
          },
          index: 1
        }
      },
      // ⑳ K列 条件付き書式 - エラー（赤）
      {
        addConditionalFormatRule: {
          rule: {
            ranges: [{ sheetId, startRowIndex: 1, startColumnIndex: 10, endColumnIndex: 11 }],
            booleanRule: {
              condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'エラー' }] },
              format: {
                backgroundColor: { red: 1.0, green: 0.87, blue: 0.87 },
                textFormat: { foregroundColor: { red: 0.7, green: 0.1, blue: 0.1 }, bold: true }
              }
            }
          },
          index: 2
        }
      },
      // ㉑ B・C列（URL）を青テキスト＋下線
      {
        repeatCell: {
          range: { sheetId, startRowIndex: 1, endRowIndex: 10000, startColumnIndex: 1, endColumnIndex: 3 },
          cell: {
            userEnteredFormat: {
              textFormat: {
                foregroundColor: { red: 0.1, green: 0.3, blue: 0.8 },
                underline: true,
                fontSize: 11
              }
            }
          },
          fields: 'userEnteredFormat.textFormat'
        }
      },
      // ㉒ 列の固定（A列を固定）
      {
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 }
          },
          fields: 'gridProperties.frozenRowCount,gridProperties.frozenColumnCount'
        }
      }
    ]
  }
})

console.log('✅ フォーマット完了')
console.log(`URL: https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`)
