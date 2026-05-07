import { NextRequest, NextResponse } from 'next/server'
import { getProjects, createProject, getRunsForProject } from '@/lib/project-manager'
import { getProjectsStats } from '@/lib/companies-db'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const projects = await getProjects()
    // Single SQL query for all project stats (replaces N×2 count queries)
    const statsMap = await getProjectsStats(projects.map((p) => p.id))
    const runsLists = await Promise.all(projects.map((p) => getRunsForProject(p.id)))
    const data = projects.map((p, i) => {
      const stats = statsMap.get(p.id)
      return {
        ...p,
        runCount: runsLists[i].length,
        companyCount: stats?.companyCount ?? 0,
        formFoundCount: stats?.formFoundCount ?? 0,
      }
    })
    return NextResponse.json({ success: true, data })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

const CreateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const body = CreateSchema.parse(await req.json())
    const project = await createProject(body.name, body.description)
    return NextResponse.json({ success: true, data: project })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
