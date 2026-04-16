import { NextRequest, NextResponse } from 'next/server'
import { getSheetData, getSheetDataByProject } from '@/lib/sheets-client'
import { addCompanies, mapSheetRowToInput } from '@/lib/companies-db'

// POST /api/companies/import-from-sheets
// Body: { projectId?: string }
// Reads from Google Sheets and imports into local companies.json with dedup
export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}))
    const { projectId } = body as { projectId?: string }

    const rows = projectId
      ? await getSheetDataByProject(projectId)
      : await getSheetData()

    const inputs = rows
      .filter((r) => r['フォームURL'])
      .map(mapSheetRowToInput)

    const { added, duplicates } = addCompanies(inputs)

    return NextResponse.json({ success: true, imported: added, duplicates, total: rows.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
