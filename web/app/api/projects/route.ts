import { NextRequest, NextResponse } from 'next/server'
import { getProjects, createProject, getRunsForProject } from '@/lib/project-manager'
import { getProjectsStats } from '@/lib/companies-db'
import { z } from 'zod'

export async function GET() {
  try {
    const projects = getProjects()
    // Single SQL query for all project stats (replaces N×2 count queries)
    const statsMap = getProjectsStats(projects.map((p) => p.id))
    const data = projects.map((p) => {
      const stats = statsMap.get(p.id)
      return {
        ...p,
        runCount: getRunsForProject(p.id).length,
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
  industry: z.string().optional(),
})

export async function POST(req: NextRequest) {
  try {
    const body = CreateSchema.parse(await req.json())
    const project = createProject(body.name, body.description, body.industry)
    return NextResponse.json({ success: true, data: project })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
