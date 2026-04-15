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

    return NextResponse.json({ companies, total: companies.length })
  } catch (error) {
    console.error('GET /api/companies error:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve companies' },
      { status: 500 }
    )
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
      return NextResponse.json(
        { error: 'Request body must include companies array' },
        { status: 400 }
      )
    }

    const { added, duplicates } = addCompanies(companies)

    return NextResponse.json({ added, duplicates })
  } catch (error) {
    console.error('POST /api/companies error:', error)
    return NextResponse.json(
      { error: 'Failed to add companies' },
      { status: 500 }
    )
  }
}
