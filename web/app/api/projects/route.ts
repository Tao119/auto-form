import { NextRequest, NextResponse } from 'next/server'
import { getProjects, createProject, getRunsForProject } from '@/lib/project-manager'
import { z } from 'zod'

export async function GET() {
  try {
    const projects = getProjects()
    const data = projects.map((p) => ({
      ...p,
      runCount: getRunsForProject(p.id).length,
    }))
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
    const project = createProject(body.name, body.description)
    return NextResponse.json({ success: true, data: project })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
