import { NextRequest, NextResponse } from 'next/server'
import { getSheetDataAsCSV, COLUMNS } from '@/lib/sheets-client'
import { getCompanies } from '@/lib/companies-db'
import { getProject, getProjectRun } from '@/lib/project-manager'
import type { CompanyRow } from '@/lib/types'
import type { Company } from '@/lib/companies-db'

function toRow(c: Company): CompanyRow {
  return {
    '会社名': c.name,
    'HP URL': c.hpUrl,
    'フォームURL': c.formUrl,
    '電話番号': c.phone,
    'メールアドレス': c.email,
    '住所': c.address,
    '業種': c.industry,
    'エリア': c.area,
    'フォーム種別': c.formType,
    '収集日時': c.collectedAt,
    'ステータス': c.status,
    '備考': c.notes,
    'プロジェクトID': c.projectId,
    '実行ID': c.runId,
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const projectId = searchParams.get('projectId') || ''
  const runId = searchParams.get('runId') || ''
  const filterIndustry = searchParams.get('industry') || ''
  const filterArea = searchParams.get('area') || ''
  const filterStatus = searchParams.get('status') || ''
  const filterFormType = searchParams.get('formType') || ''

  try {
    const companies = getCompanies({
      projectId: projectId || undefined,
      runId: runId || undefined,
    })

    let rows: CompanyRow[] = companies.map(toRow)

    if (filterIndustry) rows = rows.filter((r) => r['業種'].includes(filterIndustry))
    if (filterArea) rows = rows.filter((r) => r['エリア'].includes(filterArea))
    if (filterStatus) rows = rows.filter((r) => r['ステータス'] === filterStatus)
    if (filterFormType) rows = rows.filter((r) => r['フォーム種別'] === filterFormType)

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
