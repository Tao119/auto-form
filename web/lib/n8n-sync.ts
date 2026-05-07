/**
 * Server-side sync: checks all 'running' project runs against the n8n API
 * and updates their status. Called from API routes so status stays fresh
 * even if the browser was closed during execution.
 */

import { getProjects, getRunsForProject, updateRunStatus } from './project-manager'
import { markJobDone } from './run-queue'
import { getExecution } from './n8n-client'

/** GPT-4o-mini pricing (USD per 1M tokens) */
const PRICING = {
  'gpt-4o-mini': { input: 0.15, output: 0.60 },
  'gpt-4o':      { input: 2.50, output: 10.00 },
  'gpt-4':       { input: 30.0, output: 60.00 },
  default:       { input: 0.15, output: 0.60 },
} as const

export function calcCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICING[model as keyof typeof PRICING] ?? PRICING.default
  return (inputTokens * price.input + outputTokens * price.output) / 1_000_000
}

/**
 * Sync a single run: if it's 'running' and has an n8nExecutionId,
 * check n8n and update status. Returns true if status changed.
 */
export async function syncRun(runId: string, n8nExecutionId: string): Promise<boolean> {
  try {
    const exec = await getExecution(n8nExecutionId)
    if (!exec.finished && exec.status !== 'error') return false

    const finalStatus = exec.status === 'success' ? 'success' : 'error'

    // Extract token usage from n8n execution data if available
    let tokensInput: number | undefined
    let tokensOutput: number | undefined
    let estimatedCostUsd: number | undefined

    try {
      const runData = exec.data?.resultData?.runData
      if (runData) {
        let totalInput = 0
        let totalOutput = 0
        for (const nodeResults of Object.values(runData)) {
          for (const item of (nodeResults as unknown[])) {
            const usage = (item as { data?: { main?: [{ json?: { usage?: { prompt_tokens?: number; completion_tokens?: number } } }][] } })
              ?.data?.main?.[0]?.[0]?.json?.usage
            if (usage) {
              totalInput += usage.prompt_tokens ?? 0
              totalOutput += usage.completion_tokens ?? 0
            }
          }
        }
        if (totalInput > 0 || totalOutput > 0) {
          tokensInput = totalInput
          tokensOutput = totalOutput
          estimatedCostUsd = calcCostUsd('gpt-4o-mini', totalInput, totalOutput)
        }
      }
    } catch {
      // Token extraction is best-effort
    }

    await updateRunStatus(runId, finalStatus, n8nExecutionId, undefined, {
      tokensInput,
      tokensOutput,
      estimatedCostUsd,
      completedAt: exec.stoppedAt ?? new Date().toISOString(),
    })

    // Also mark the queue job as done and trigger next
    const nextJob = await markJobDone(runId, finalStatus === 'success' ? 'completed' : 'failed')
    if (nextJob) {
      // Fire the next queued job in the background
      triggerQueuedJob(nextJob.runId, nextJob.params).catch(() => {})
    }

    return true
  } catch {
    return false
  }
}

/**
 * Sync ALL running runs across all projects.
 * Designed to be called on-demand (e.g., when loading history/project pages).
 */
export async function syncAllRunningJobs(): Promise<{ synced: number }> {
  const projects = await getProjects()
  let synced = 0

  const runsLists = await Promise.all(projects.map((p) => getRunsForProject(p.id)))
  await Promise.allSettled(
    runsLists.flatMap((runs) =>
      runs
        .filter((r) => r.status === 'running' && r.n8nExecutionId)
        .map(async (r) => {
          const changed = await syncRun(r.id, r.n8nExecutionId!)
          if (changed) synced++
        })
    )
  )

  return { synced }
}

/** Trigger a queued job by calling our own queue/start endpoint internally. */
async function triggerQueuedJob(runId: string, params: import('./types').ExecuteParams): Promise<void> {
  const baseUrl = process.env.INTERNAL_BASE_URL || 'http://localhost:3003'
  await fetch(`${baseUrl}/api/queue/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, params }),
  })
}
