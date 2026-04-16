import { NextRequest, NextResponse } from 'next/server'
import { getProject, deleteProject, getRunsForProject } from '@/lib/project-manager'
import { countCompanies } from '@/lib/companies-db'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const project = getProject(params.id)
    if (!project) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    const runs = getRunsForProject(params.id)
    // Lightweight DB stats for the project header
    const totalCount = countCompanies({ projectId: params.id })
    const formFoundCount = countCompanies({ projectId: params.id, hasForm: 'true' })
    return NextResponse.json({ success: true, data: { ...project, runs, totalCount, formFoundCount } })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    deleteProject(params.id)
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}
