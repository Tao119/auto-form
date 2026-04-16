import { NextRequest, NextResponse } from 'next/server'
import { getCompanies, countCompanies, getDistinctValues } from '@/lib/companies-db'
import type { Company, CompanySortBy, CompanySortDir } from '@/lib/companies-db'
import type { CompanyRow } from '@/lib/types'

function toRow(c: Company): CompanyRow {
  return {
    id: c.id,
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
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') || '100', 10)))
  const projectId = searchParams.get('projectId') || undefined
  const runId = searchParams.get('runId') || undefined

  const sortBy = (searchParams.get('sortBy') || 'collectedAt') as CompanySortBy
  const sortDir = (searchParams.get('sortDir') === 'ASC' ? 'ASC' : 'DESC') as CompanySortDir

  const baseFilters = {
    projectId,
    runId,
    industry:  searchParams.get('industry') || undefined,
    area:      searchParams.get('area') || undefined,
    status:    searchParams.get('status') || undefined,
    formType:  searchParams.get('formType') || undefined,
    search:    searchParams.get('search') || undefined,
    hasForm:   searchParams.get('hasForm') || undefined,
  }

  try {
    // Count and paginate in SQLite — no full table scans in JS
    const total = countCompanies(baseFilters)
    const offset = (page - 1) * limit
    const companies = getCompanies({ ...baseFilters, limit, offset, sortBy, sortDir })
    const data = companies.map(toRow)

    // Distinct values for dropdown filters (scoped to project, no other filters)
    const { industries, areas } = getDistinctValues(projectId)

    return NextResponse.json({ success: true, data, total, page, limit, industries, areas })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg, data: [] as CompanyRow[] }, { status: 500 })
  }
}
