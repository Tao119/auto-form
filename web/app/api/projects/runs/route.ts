import { NextResponse } from 'next/server'
import { getProjects, getRunsForProject } from '@/lib/project-manager'

export const dynamic = 'force-dynamic'

/** GET /api/projects/runs — 全プロジェクトの全ランを新しい順で返す */
export async function GET() {
  try {
    const projects = getProjects()
    const projectMap: Record<string, { id: string; name: string }> = {}
    for (const p of projects) projectMap[p.id] = { id: p.id, name: p.name }

    const allRuns = projects
      .flatMap((p) => getRunsForProject(p.id))
      // Hide child runs — they belong to a batch parent and should not appear in history
      .filter((r) => !r.parentRunId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

    const data = allRuns.map((r) => ({
      ...r,
      projectName: projectMap[r.projectId]?.name ?? r.projectId,
    }))

    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}
