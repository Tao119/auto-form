import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { triggerWorkflow } from '@/lib/n8n-client'
import { updateRunStatus } from '@/lib/project-manager'
import { markJobDone } from '@/lib/run-queue'
import type { ExecuteParams } from '@/lib/types'

const Schema = z.object({
  runId: z.string(),
  params: z.object({
    industry: z.string(),
    area: z.string(),
    areas: z.array(z.string()).optional(),
    keywords: z.array(z.string()).optional(),
    maxResults: z.number().optional(),
    projectId: z.string(),
    runId: z.string(),
    searchMode: z.enum(['prefecture', 'radius']).optional(),
    lat: z.number().optional(),
    lng: z.number().optional(),
    radiusKm: z.number().optional(),
  }),
})

/**
 * POST /api/queue/start
 * キューから次のジョブを実際にn8nで起動する（内部用）。
 */
export async function POST(req: NextRequest) {
  try {
    const { runId, params } = Schema.parse(await req.json())
    const execParams = params as ExecuteParams

    try {
      const result = await triggerWorkflow(execParams)
      updateRunStatus(runId, 'running', result.executionId)
      return NextResponse.json({ success: true, executionId: result.executionId })
    } catch (triggerErr) {
      // Trigger failed — mark both run and queue job as failed
      updateRunStatus(runId, 'error')
      markJobDone(runId, 'failed', String(triggerErr))
      return NextResponse.json({ success: false, error: String(triggerErr) }, { status: 502 })
    }
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
