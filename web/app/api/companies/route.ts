import { NextRequest, NextResponse } from 'next/server'
import { getCompanies, addCompanies, updateCompany, batchUpdateStatus, batchUpdateStatusByFilter } from '@/lib/companies-db'
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

const VALID_STATUSES = ['未送信', '送信済み', 'エラー', 'スキップ'] as const
const StatusEnum = z.enum(VALID_STATUSES)

const FilterSchema = z.object({
  projectId: z.string().optional(),
  runId:     z.string().optional(),
  industry:  z.string().optional(),
  area:      z.string().optional(),
  status:    z.string().optional(),
  formType:  z.string().optional(),
  hasForm:   z.enum(['true', 'false', '']).optional(),
  hasPhone:  z.enum(['true', '']).optional(),
  hasEmail:  z.enum(['true', '']).optional(),
  search:    z.string().optional(),
})

const PatchSchema = z.union([
  // Single company: supports status and/or notes update
  z.object({
    id: z.string(),
    status: StatusEnum.optional(),
    notes: z.string().max(500).optional(),
  }).refine((d) => d.status !== undefined || d.notes !== undefined, { message: 'status or notes required' }),
  // Bulk by IDs (no notes support for batch)
  z.object({ ids: z.array(z.string()).min(1).max(5000), status: StatusEnum }),
  // Bulk by filter — "select all pages" UX
  z.object({ filter: FilterSchema, status: StatusEnum }),
])

// PATCH /api/companies
// Body: { id, status?, notes? }  or  { ids[], status }  or  { filter, status }
export async function PATCH(req: NextRequest) {
  try {
    const body = PatchSchema.parse(await req.json())
    if ('filter' in body) {
      const updated = batchUpdateStatusByFilter(body.filter, body.status)
      return NextResponse.json({ success: true, updated })
    } else if ('ids' in body) {
      const updated = batchUpdateStatus(body.ids, body.status)
      return NextResponse.json({ success: true, updated })
    } else {
      const ok = updateCompany(body.id, { status: body.status, notes: body.notes })
      return NextResponse.json({ success: ok, updated: ok ? 1 : 0 })
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 400 })
  }
}
