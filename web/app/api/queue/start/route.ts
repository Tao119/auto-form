import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { triggerWorkflow } from '@/lib/n8n-client'
import { updateRunStatus } from '@/lib/project-manager'
import type { ExecuteParams } from '@/lib/types'

const Schema = z.object({
  runId: z.string(),
  params: z.object({
    industry: z.string(),
    area: z.string(),
    keywords: z.array(z.string()).optional(),
    maxResults: z.number().optional(),
    projectId: z.string(),
    runId: z.string(),
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

    const result = await triggerWorkflow(execParams)
    updateRunStatus(runId, 'running', result.executionId)

    return NextResponse.json({ success: true, executionId: result.executionId })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
