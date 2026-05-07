import { NextRequest, NextResponse } from 'next/server'
import { getProject, deleteProject, getRunsForProject } from '@/lib/project-manager'
import { getCompanyStats } from '@/lib/companies-db'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const project = await getProject(params.id)
    if (!project) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    // Exclude child runs (parentRunId set) — they are internal and shown only via their batch parent
    const runs = (await getRunsForProject(params.id)).filter((r) => !r.parentRunId)
    // Single aggregation query instead of two COUNT queries
    const stats = await getCompanyStats(params.id)
    return NextResponse.json({ success: true, data: { ...project, runs, totalCount: stats.total, formFoundCount: stats.formFoundCount } })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    await deleteProject(params.id)
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}
