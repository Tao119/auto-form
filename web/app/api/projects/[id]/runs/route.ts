import { NextRequest, NextResponse } from 'next/server'
import { getRunsForProject, addRunToProject } from '@/lib/project-manager'
import { z } from 'zod'

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const runs = getRunsForProject(params.id)
    return NextResponse.json({ success: true, data: runs })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

const AddRunSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  searchTarget: z.object({
    industry: z.string(),
    area: z.string(),
    keywords: z.array(z.string()),
    maxResults: z.number().int().min(1),
  }),
})

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  try {
    const body = AddRunSchema.parse(await req.json())
    const run = addRunToProject(params.id, body)
    return NextResponse.json({ success: true, data: run })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
