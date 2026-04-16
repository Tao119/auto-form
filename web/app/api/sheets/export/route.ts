import { NextRequest, NextResponse } from 'next/server'
import { COLUMNS } from '@/lib/sheets-client'
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

function rowsToCsv(rows: CompanyRow[]): string {
  const BOM = '\uFEFF'
  const header = COLUMNS.join(',')
  const body = rows.map((row) =>
    COLUMNS.map((col) => {
      const val = row[col as keyof CompanyRow] || ''
      return `"${val.replace(/"/g, '""')}"`
    }).join(',')
  ).join('\n')
  return BOM + header + '\n' + body
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const projectId = searchParams.get('projectId') || undefined
  const runId = searchParams.get('runId') || undefined

  const idsParam = searchParams.get('ids')
  const ids = idsParam ? idsParam.split(',').filter(Boolean) : undefined

  const filters = {
    projectId,
    runId,
    industry: searchParams.get('industry') || undefined,
    area:     searchParams.get('area') || undefined,
    status:   searchParams.get('status') || undefined,
    formType: searchParams.get('formType') || undefined,
    search:   searchParams.get('search') || undefined,
    hasForm:  searchParams.get('hasForm') || undefined,
    sortBy:   (searchParams.get('sortBy') || 'collectedAt') as import('@/lib/companies-db').CompanySortBy,
    sortDir:  (searchParams.get('sortDir') === 'ASC' ? 'ASC' : 'DESC') as import('@/lib/companies-db').CompanySortDir,
    ids,
  }

  try {
    // Push all filtering to SQLite, no limit for export
    const companies = getCompanies(filters)
    const rows = companies.map(toRow)
    const csv = rowsToCsv(rows)

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
