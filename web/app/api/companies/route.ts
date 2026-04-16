import { NextRequest, NextResponse } from 'next/server'
import { getCompanies, addCompanies, updateCompanyStatus, batchUpdateStatus } from '@/lib/companies-db'
import type { CompanyInput } from '@/lib/companies-db'
import { z } from 'zod'

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

const PatchSchema = z.union([
  z.object({ id: z.string(), status: z.string() }),
  z.object({ ids: z.array(z.string()).min(1), status: z.string() }),
])

// PATCH /api/companies
// Body: { id: string, status: string } or { ids: string[], status: string }
export async function PATCH(req: NextRequest) {
  try {
    const body = PatchSchema.parse(await req.json())
    if ('ids' in body) {
      const updated = batchUpdateStatus(body.ids, body.status)
      return NextResponse.json({ success: true, updated })
    } else {
      const ok = updateCompanyStatus(body.id, body.status)
      return NextResponse.json({ success: ok, updated: ok ? 1 : 0 })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 400 })
  }
}
