import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { updateRunStatus, getProjectRun, rollupBatchRun } from '@/lib/project-manager'
import { markJobDone, isQueueIdle } from '@/lib/run-queue'
import { calcCostUsd } from '@/lib/n8n-sync'
import { addCompanies, countCompanies } from '@/lib/companies-db'
import type { CompanyInput } from '@/lib/companies-db'

const ResultsSchema = z.object({
  totalCompanies: z.number().int().min(0).optional(),
  afterDedup:     z.number().int().min(0).optional(),
  successCount:   z.number().int().min(0).optional(),
  errorCount:     z.number().int().min(0).optional(),
  formFoundCount: z.number().int().min(0).optional(),
  formFoundRate:  z.number().int().min(0).optional(),
  itemsWritten:   z.number().int().min(0).optional(),
  elapsedMs:      z.number().int().min(0).optional(),
  avgMsPerItem:   z.number().int().min(0).optional(),
  subAreaCount:   z.number().int().min(0).optional(),
  queryCount:     z.number().int().min(0).optional(),
}).optional()

// Strict company schema — reject malformed records before DB insert
const CompanySchema = z.object({
  name:        z.string().default(''),
  hpUrl:       z.string().default(''),
  formUrl:     z.string().default(''),
  phone:       z.string().optional(),
  email:       z.string().optional(),
  address:     z.string().optional(),
  industry:    z.string().optional(),
  area:        z.string().optional(),
  formType:    z.string().optional(),
  status:      z.string().optional(),
  notes:       z.string().optional(),
  projectId:   z.string().optional(),
  runId:       z.string().optional(),
  collectedAt: z.string().optional(),
})

const Schema = z.object({
  status:       z.enum(['success', 'error']),
  itemsWritten: z.number().int().min(0).optional(),
  tokensInput:  z.number().int().min(0).optional(),
  tokensOutput: z.number().int().min(0).optional(),
  model:        z.string().optional(),
  error:        z.string().optional(),
  results:      ResultsSchema,
  companies:    z.array(z.unknown()).optional(),  // validated individually below
})

/**
 * POST /api/projects/runs/[runId]/complete
 * n8n ワークフローの最終ノードから呼ばれるコールバック。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { runId: string } }
) {
  try {
    const body = Schema.parse(await req.json())
    const { runId } = params

    // コスト計算: Google Custom Search API + OpenAI LLM の両方を合算する
    // CSE: queryCount × $0.005/query ($5/1000クエリ)
    // OpenAI GPT: tokensInput/tokensOutput から calcCostUsd で計算
    const CSE_COST_PER_QUERY = 0.005
    let gptCostUsd = 0
    let searchCostUsd = 0
    if (body.tokensInput !== undefined && body.tokensOutput !== undefined) {
      gptCostUsd = calcCostUsd(body.model ?? 'gpt-4o-mini', body.tokensInput, body.tokensOutput)
    }
    const queryCount = body.results?.queryCount ?? body.results?.subAreaCount
    if (queryCount !== undefined && queryCount > 0) {
      searchCostUsd = queryCount * CSE_COST_PER_QUERY
    }
    const totalCost = gptCostUsd + searchCostUsd
    const estimatedCostUsd = totalCost > 0 ? totalCost : undefined

    // Validate and filter company records
    let actualAdded = 0
    let actualUpgraded = 0
    if (body.companies?.length) {
      const validCompanies: CompanyInput[] = []
      for (const raw of body.companies) {
        const parsed = CompanySchema.safeParse(raw)
        if (!parsed.success) continue
        const c = parsed.data
        // Skip records with neither a name nor an HP URL
        if (!c.name && !c.hpUrl) continue
        validCompanies.push(c as CompanyInput)
      }
      if (validCompanies.length > 0) {
        const { added, upgraded } = addCompanies(validCompanies)
        actualAdded = added
        actualUpgraded = upgraded
      }
    }

    // Use actual SQLite row count for this runId as the authoritative itemsWritten.
    // This reflects dedup-after state: companies that were flagged as duplicates of other runs
    // still land in DB under this runId, so the count matches what the results page shows.
    const dbRunCount = body.companies?.length ? countCompanies({ runId }) : 0
    const itemsWritten = dbRunCount > 0 ? dbRunCount : (body.itemsWritten ?? body.results?.itemsWritten ?? 0)

    updateRunStatus(runId, body.status, undefined, itemsWritten, {
      tokensInput: body.tokensInput,
      tokensOutput: body.tokensOutput,
      estimatedCostUsd,
      completedAt: new Date().toISOString(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      results: body.results as any,
      error: body.status === 'error' ? (body.error ?? 'Unknown error') : undefined,
    })

    // If this is a child run, roll up stats into the batch parent (idempotent once all done)
    const completedRun = getProjectRun(runId)
    if (completedRun?.parentRunId) {
      rollupBatchRun(completedRun.parentRunId)
    }

    // Trigger next queued job
    const next = markJobDone(runId, body.status === 'success' ? 'completed' : 'failed', body.error)
    const base = process.env.INTERNAL_BASE_URL || 'http://localhost:3003'
    if (next) {
      fetch(`${base}/api/queue/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runId: next.runId, params: next.params }),
      }).catch(() => {})
    } else if (isQueueIdle()) {
      // Queue is fully drained — run DB housekeeping in the background (non-blocking).
      // Also prune rows older than 90 days that are in terminal statuses (送信済み, スキップ)
      // to keep the DB lean without manual intervention.
      fetch(`${base}/api/admin/maintenance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prune: true, daysOld: 90 }),
      }).catch(() => {})
    }

    return NextResponse.json({ success: true, itemsWritten, upgraded: actualUpgraded })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
