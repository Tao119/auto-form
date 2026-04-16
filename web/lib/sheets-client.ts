import { google } from 'googleapis'
import fs from 'fs'
import path from 'path'
import type { CompanyRow } from './types'

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID || ''
const SHEET_NAME = process.env.GOOGLE_SHEETS_SHEET_NAME || '企業リスト'
const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(process.cwd(), '../config')

function getAuth() {
  const credsPath = path.join(CONFIG_DIR, 'oauth2-credentials.json')
  const tokenPath = path.join(CONFIG_DIR, 'oauth2-token.json')

  const creds = JSON.parse(fs.readFileSync(credsPath, 'utf-8'))
  const token = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))

  const { client_id, client_secret } = creds.installed || creds.web
  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    'http://localhost:3333/callback'
  )
  oauth2Client.setCredentials(token)

  oauth2Client.on('tokens', (newTokens) => {
    const current = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'))
    const merged = { ...current, ...newTokens }
    fs.writeFileSync(tokenPath, JSON.stringify(merged, null, 2))
  })

  return oauth2Client
}

export const COLUMNS = [
  '会社名', 'HP URL', 'フォームURL', '電話番号',
  'メールアドレス', '住所', '業種', 'エリア',
  'フォーム種別', '収集日時', 'ステータス', '備考',
  'プロジェクトID', '実行ID',
]

// A2:N = 14 columns
const RANGE = `${SHEET_NAME}!A2:N`

export async function getSheetData(): Promise<CompanyRow[]> {
  const auth = getAuth()
  const sheets = google.sheets({ version: 'v4', auth })

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: RANGE,
  })

  const rows = res.data.values || []
  return rows.map((row) => {
    const obj: Record<string, string> = {}
    COLUMNS.forEach((col, i) => { obj[col] = row[i] || '' })
    return obj as unknown as CompanyRow
  })
}

export async function getSheetDataByProject(projectId: string): Promise<CompanyRow[]> {
  const rows = await getSheetData()
  return rows.filter((r) => r['プロジェクトID'] === projectId)
}

export async function getSheetDataByRun(runId: string): Promise<CompanyRow[]> {
  const rows = await getSheetData()
  return rows.filter((r) => r['実行ID'] === runId)
}

export async function getSheetDataAsCSV(rows?: CompanyRow[]): Promise<string> {
  const data = rows || await getSheetData()
  const BOM = '\uFEFF'
  const header = COLUMNS.join(',')
  const body = data.map((row) =>
    COLUMNS.map((col) => {
      const val = row[col as keyof CompanyRow] || ''
      return `"${val.replace(/"/g, '""')}"`
    }).join(',')
  ).join('\n')
  return BOM + header + '\n' + body
}

export async function getSheetStats(projectId?: string): Promise<{
  total: number
  formFoundCount: number
  byStatus: Record<string, number>
  byFormType: Record<string, number>
}> {
  const { getCompanyStats } = await import('./companies-db')
  return getCompanyStats(projectId)
}
