import { NextRequest, NextResponse } from 'next/server'
import { getCompanies, addCompanies } from '@/lib/companies-db'
import type { CompanyInput } from '@/lib/companies-db'

// GET /api/companies?projectId=...&runId=...&industry=...&area=...
// Returns filtered company list with total count
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId') ?? undefined
    const runId = searchParams.get('runId') ?? undefined
    const industry = searchParams.get('industry') ?? undefined
    const area = searchParams.get('area') ?? undefined

    const companies = getCompanies({ projectId, runId, industry, area })
    return NextResponse.json({ success: true, companies, total: companies.length })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}

// POST /api/companies
// Body: { companies: CompanyInput[] }
// Bulk add from n8n callback; returns added/duplicates counts
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { companies } = body as { companies: CompanyInput[] }

    if (!Array.isArray(companies)) {
      return NextResponse.json({ success: false, error: 'companies array required' }, { status: 400 })
    }

    const { added, duplicates } = addCompanies(companies)
    return NextResponse.json({ success: true, added, duplicates })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
