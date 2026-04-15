import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { updateRunStatus } from '@/lib/project-manager'
import { markJobDone } from '@/lib/run-queue'
import { calcCostUsd } from '@/lib/n8n-sync'
import { addCompanies } from '@/lib/companies-db'
import type { CompanyInput } from '@/lib/companies-db'

const ResultsSchema = z.object({
  totalCompanies: z.number().int().min(0).optional(),
  afterDedup: z.number().int().min(0).optional(),
  successCount: z.number().int().min(0).optional(),
  errorCount: z.number().int().min(0).optional(),
  formFoundCount: z.number().int().min(0).optional(),
  formFoundRate: z.number().int().min(0).optional(),
  itemsWritten: z.number().int().min(0).optional(),
  elapsedMs: z.number().int().min(0).optional(),
  avgMsPerItem: z.number().int().min(0).optional(),
  subAreaCount: z.number().int().min(0).optional(),
}).optional()

const Schema = z.object({
  status: z.enum(['success', 'error']),
  itemsWritten: z.number().int().min(0).optional(),
  tokensInput: z.number().int().min(0).optional(),
  tokensOutput: z.number().int().min(0).optional(),
  model: z.string().optional(),
  error: z.string().optional(),
  results: ResultsSchema,
  companies: z.array(z.record(z.string(), z.unknown())).optional(),
})

/**
 * POST /api/projects/runs/[runId]/complete
 * n8n ワークフローの最終ノードから呼ばれるコールバック。
 * ブラウザが閉じていてもステータスが確実に更新される。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { runId: string } }
) {
  try {
    const body = Schema.parse(await req.json())
    const { runId } = params

    const estimatedCostUsd =
      body.tokensInput !== undefined && body.tokensOutput !== undefined
        ? calcCostUsd(body.model ?? 'gpt-4o-mini', body.tokensInput, body.tokensOutput)
        : undefined

    const itemsWritten = body.itemsWritten ?? body.results?.itemsWritten

    updateRunStatus(runId, body.status, undefined, itemsWritten, {
      tokensInput: body.tokensInput,
      tokensOutput: body.tokensOutput,
      estimatedCostUsd,
      completedAt: new Date().toISOString(),
      results: body.results as any,
    })

    // Save collected companies to local DB
    if (body.companies?.length) {
      addCompanies(body.companies as unknown as CompanyInput[])
    }

    // Trigger next queued job
    const next = markJobDone(runId, body.status === 'success' ? 'completed' : 'failed', body.error)
    if (next) {
      const base = process.env.INTERNAL_BASE_URL || 'http://localhost:3003'
      fetch(`${base}/api/queue/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: next.runId, params: next.params }),
      }).catch(() => {})
    }

    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
