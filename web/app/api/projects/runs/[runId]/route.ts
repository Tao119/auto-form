import { NextRequest, NextResponse } from 'next/server'
import { getProjectRun, updateRunStatus } from '@/lib/project-manager'
import { getQueuePosition, markJobDone } from '@/lib/run-queue'
import { z } from 'zod'

export async function GET(_req: NextRequest, { params }: { params: { runId: string } }) {
  try {
    const run = getProjectRun(params.runId)
    if (!run) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 })
    // Attach live queue position so the execute panel can show correct status
    const queuePosition = (run.status === 'pending' || run.status === 'running')
      ? getQueuePosition(params.runId)
      : 0
    return NextResponse.json({ success: true, data: { ...run, queuePosition } })
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

    // When a run is manually canceled (set to 'error'), advance the queue so waiting
    // jobs are not blocked. markJobDone is idempotent — safe to call even if n8n also
    // completes the job afterwards.
    if (body.status === 'error') {
      const next = markJobDone(params.runId, 'failed', 'canceled_by_user')
      if (next) {
        const base = process.env.INTERNAL_BASE_URL || 'http://localhost:3003'
        fetch(`${base}/api/queue/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: next.runId, params: next.params }),
        }).catch(() => {})
      }
    }

    const run = getProjectRun(params.runId)
    return NextResponse.json({ success: true, data: run })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
