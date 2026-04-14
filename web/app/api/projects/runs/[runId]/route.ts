import { NextRequest, NextResponse } from 'next/server'
import { getProjectRun, updateRunStatus } from '@/lib/project-manager'
import { z } from 'zod'

export async function GET(_req: NextRequest, { params }: { params: { runId: string } }) {
  try {
    const run = getProjectRun(params.runId)
    if (!run) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    return NextResponse.json({ success: true, data: run })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

const PatchSchema = z.object({
  status: z.enum(['pending', 'running', 'success', 'error']),
  n8nExecutionId: z.string().optional(),
  itemsWritten: z.number().int().optional(),
  tokensInput: z.number().int().optional(),
  tokensOutput: z.number().int().optional(),
  estimatedCostUsd: z.number().optional(),
  completedAt: z.string().optional(),
  rawSearchCount: z.number().int().optional(),
})

export async function PATCH(req: NextRequest, { params }: { params: { runId: string } }) {
  try {
    const body = PatchSchema.parse(await req.json())
    updateRunStatus(params.runId, body.status, body.n8nExecutionId, body.itemsWritten, {
      tokensInput: body.tokensInput,
      tokensOutput: body.tokensOutput,
      estimatedCostUsd: body.estimatedCostUsd,
      completedAt: body.completedAt,
      rawSearchCount: body.rawSearchCount,
    })
    const run = getProjectRun(params.runId)
    return NextResponse.json({ success: true, data: run })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
