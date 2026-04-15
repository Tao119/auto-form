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
      const companies = getCompanies({ projectId })
      formUrls = companies.map((c) => c.normalizedFormUrl).filter(Boolean)
    } else {
      formUrls = Array.from(getFormUrls())
    }

    return NextResponse.json({ formUrls })
  } catch (error) {
    console.error('GET /api/companies/form-urls error:', error)
    return NextResponse.json(
      { error: 'Failed to retrieve form URLs' },
      { status: 500 }
    )
  }
}
