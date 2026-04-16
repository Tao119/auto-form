import { NextRequest, NextResponse } from 'next/server'
import { getCompanies } from '@/lib/companies-db'
import type { Company } from '@/lib/companies-db'
import type { CompanyRow } from '@/lib/types'

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
  const page = parseInt(searchParams.get('page') || '1', 10)
  const limit = parseInt(searchParams.get('limit') || '100', 10)
  const filterIndustry = searchParams.get('industry') || ''
  const filterArea = searchParams.get('area') || ''
  const filterStatus = searchParams.get('status') || ''
  const filterFormType = searchParams.get('formType') || ''
  const filterSearch = searchParams.get('search') || ''
  const projectId = searchParams.get('projectId') || ''
  const runId = searchParams.get('runId') || ''

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
    if (filterSearch) {
      const q = filterSearch.toLowerCase()
      rows = rows.filter((r) =>
        r['会社名'].toLowerCase().includes(q) ||
        r['HP URL'].toLowerCase().includes(q) ||
        r['フォームURL'].toLowerCase().includes(q)
      )
    }

    const total = rows.length
    const start = (page - 1) * limit
    const data = rows.slice(start, start + limit)

    const allForFilters = getCompanies({ projectId: projectId || undefined }).map(toRow)
    const industries = [...new Set(allForFilters.map((r) => r['業種']).filter(Boolean))].sort()
    const areas = [...new Set(allForFilters.map((r) => r['エリア']).filter(Boolean))].sort()

    return NextResponse.json({ success: true, data, total, page, limit, industries, areas })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg, data: [] as CompanyRow[] }, { status: 500 })
  }
}
