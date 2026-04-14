import { NextRequest, NextResponse } from 'next/server'
import { getSheetData, getSheetDataByProject, getSheetDataByRun, getSheetDataAsCSV } from '@/lib/sheets-client'
import { getProject, getProjectRun } from '@/lib/project-manager'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const projectId = searchParams.get('projectId') || ''
  const runId = searchParams.get('runId') || ''
  const filterIndustry = searchParams.get('industry') || ''
  const filterArea = searchParams.get('area') || ''
  const filterStatus = searchParams.get('status') || ''

  try {
    let rows = runId
      ? await getSheetDataByRun(runId)
      : projectId
      ? await getSheetDataByProject(projectId)
      : await getSheetData()

    if (filterIndustry) rows = rows.filter((r) => r['業種'].includes(filterIndustry))
    if (filterArea) rows = rows.filter((r) => r['エリア'].includes(filterArea))
    if (filterStatus) rows = rows.filter((r) => r['ステータス'] === filterStatus)

    const csv = await getSheetDataAsCSV(rows)

    let filename = '企業リスト'
    if (runId) {
      const run = getProjectRun(runId)
      if (run) filename = run.label.replace(/[\s/:]/g, '_')
    } else if (projectId) {
      const proj = getProject(projectId)
      if (proj) filename = proj.name.replace(/[\s/]/g, '_')
    }
    filename += `_${new Date().toISOString().slice(0, 10)}.csv`

    return new NextResponse(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      },
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
