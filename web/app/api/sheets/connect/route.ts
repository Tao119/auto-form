import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { z } from 'zod'
import { getAuthedClient } from '@/lib/google-auth'
import { getProject, linkSheets } from '@/lib/project-manager'
import { COLUMNS } from '@/lib/sheets-client'

const Schema = z.object({ projectId: z.string().min(1) })

/**
 * POST /api/sheets/connect
 * プロジェクト用のスプレッドシートを新規作成してプロジェクトに紐付ける。
 * 既にsheetsIdが設定されている場合は既存のシートを返す。
 */
export async function POST(req: NextRequest) {
  try {
    const { projectId } = Schema.parse(await req.json())
    const project = await getProject(projectId)
    if (!project) return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 })

    // すでに紐付き済み
    if (project.sheetsId) {
      return NextResponse.json({ success: true, sheetsId: project.sheetsId, created: false })
    }

    const auth = getAuthedClient()
    const sheets = google.sheets({ version: 'v4', auth })
    const drive  = google.drive({ version: 'v3', auth })

    // スプレッドシート作成
    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title: `[auto-form] ${project.name}` },
        sheets: [
          { properties: { title: '全件' } },
        ],
      },
    })

    const sheetsId = created.data.spreadsheetId!
    const sheetId  = created.data.sheets![0].properties!.sheetId!

    // ヘッダ行書き込み
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetsId,
      range: '全件!A1',
      valueInputOption: 'RAW',
      requestBody: { values: [COLUMNS] },
    })

    // ヘッダ行を太字・背景色で固定
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: sheetsId,
      requestBody: {
        requests: [
          {
            repeatCell: {
              range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.23, green: 0.47, blue: 0.85 },
                  textFormat: { bold: true, foregroundColor: { red: 1, green: 1, blue: 1 } },
                },
              },
              fields: 'userEnteredFormat(backgroundColor,textFormat)',
            },
          },
          {
            updateSheetProperties: {
              properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
              fields: 'gridProperties.frozenRowCount',
            },
          },
        ],
      },
    })

    // Driveで共有設定（閲覧者リンクは不要、オーナーのみ）
    // 必要なら drive.permissions.create で共有追加可

    // プロジェクトに紐付け
    await linkSheets(projectId, sheetsId)

    const url = `https://docs.google.com/spreadsheets/d/${sheetsId}`
    return NextResponse.json({ success: true, sheetsId, url, created: true })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = msg.includes('未認証') ? 401 : 500
    return NextResponse.json({ success: false, error: msg }, { status })
  }
}
