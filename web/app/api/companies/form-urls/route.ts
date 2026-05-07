import { NextRequest, NextResponse } from 'next/server'
import { getFormUrls, getCompanies } from '@/lib/companies-db'

// GET /api/companies/form-urls?projectId=...
// Returns normalized form URLs for n8n dedup check (replaces L-05 node)
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId') ?? undefined

    let formUrls: string[]

    if (projectId) {
      const companies = await getCompanies({ projectId })
      formUrls = companies.map((c) => c.normalizedFormUrl).filter(Boolean)
    } else {
      formUrls = Array.from(await getFormUrls())
    }

    return NextResponse.json({ success: true, formUrls })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
