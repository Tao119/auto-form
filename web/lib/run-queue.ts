import getSql from './db'
import type { QueueJob, ExecuteParams } from './types'
import { updateRunStatus, expireStaleRuns, getProjectRun } from './project-manager'

export const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_RUNS || '3', 10)

let _startupRecoveryDone = false

function rowToJob(r: Record<string, unknown>): QueueJob {
  return {
    id:          r.id as string,
    runId:       r.run_id as string,
    projectId:   r.project_id as string,
    status:      r.status as QueueJob['status'],
    params:      r.params as ExecuteParams,
    createdAt:   r.created_at as string,
    startedAt:   r.started_at as string | undefined,
    completedAt: r.completed_at as string | undefined,
    error:       r.error as string | undefined,
  }
}

async function recoverStaleActiveJobs(): Promise<void> {
  if (_startupRecoveryDone) return
  _startupRecoveryDone = true
  const sql = getSql()
  const stale = await sql`SELECT * FROM queue_jobs WHERE status = 'active'`
  for (const row of stale) {
    const job = rowToJob(row)
    const existingRun = await getProjectRun(job.runId)
    if (existingRun?.status === 'success') {
      await sql`UPDATE queue_jobs SET status = 'completed', completed_at = ${new Date().toISOString()} WHERE id = ${job.id}`
    } else {
      await sql`UPDATE queue_jobs SET status = 'failed', completed_at = ${new Date().toISOString()}, error = 'server_restart' WHERE id = ${job.id}`
      if (existingRun && existingRun.status !== 'error') {
        await updateRunStatus(job.runId, 'error')
      }
    }
  }
}

export async function enqueue(runId: string, projectId: string, params: ExecuteParams): Promise<{
  job: QueueJob
  canStart: boolean
  queuePosition: number
}> {
  await recoverStaleActiveJobs()
  const sql = getSql()
  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const createdAt = new Date().toISOString()

  const activeRows = await sql`SELECT COUNT(*)::int as cnt FROM queue_jobs WHERE status = 'active'`
  const activeCount = activeRows[0].cnt as number
  const canStart = activeCount < MAX_CONCURRENT

  await sql`
    INSERT INTO queue_jobs (id, run_id, project_id, status, params, created_at)
    VALUES (${id}, ${runId}, ${projectId}, ${canStart ? 'active' : 'waiting'}, ${sql.json(params as unknown as Parameters<typeof sql.json>[0])}, ${createdAt})
  `

  const waitingRows = await sql`SELECT COUNT(*)::int as cnt FROM queue_jobs WHERE status = 'waiting'`
  const waitingCount = (waitingRows[0].cnt as number)

  return {
    job: { id, runId, projectId, status: canStart ? 'active' : 'waiting', params, createdAt },
    canStart,
    queuePosition: canStart ? 0 : waitingCount,
  }
}

export async function markJobActive(runId: string): Promise<void> {
  const sql = getSql()
  await sql`UPDATE queue_jobs SET status = 'active', started_at = ${new Date().toISOString()} WHERE run_id = ${runId} AND status = 'waiting'`
}

export async function markJobDone(runId: string, status: 'completed' | 'failed', error?: string): Promise<QueueJob | undefined> {
  const sql = getSql()
  const result = await sql`
    UPDATE queue_jobs SET
      status       = ${status},
      completed_at = ${new Date().toISOString()},
      error        = ${error ?? null}
    WHERE run_id = ${runId} AND status = 'active'
  `
  if (result.count === 0) return undefined

  const activeRows = await sql`SELECT COUNT(*)::int as cnt FROM queue_jobs WHERE status = 'active'`
  if ((activeRows[0].cnt as number) >= MAX_CONCURRENT) return undefined

  const nextRows = await sql`SELECT * FROM queue_jobs WHERE status = 'waiting' ORDER BY created_at ASC LIMIT 1`
  if (nextRows.length === 0) return undefined
  const next = rowToJob(nextRows[0])
  await sql`UPDATE queue_jobs SET status = 'active', started_at = ${new Date().toISOString()} WHERE id = ${next.id}`
  return { ...next, status: 'active' }
}

export async function getQueueStatus(): Promise<{
  active: number
  waiting: number
  maxConcurrent: number
  recentJobs: QueueJob[]
}> {
  await expireStaleRuns()
  const sql = getSql()

  // Auto-recover stale active jobs (> 2h)
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
  const recovered = await sql`
    UPDATE queue_jobs SET status = 'failed', completed_at = ${new Date().toISOString()}, error = 'auto_expired_stale_active'
    WHERE status = 'active' AND COALESCE(started_at, created_at) < ${cutoff}
  `
  if (recovered.count > 0) {
    const base = process.env.INTERNAL_BASE_URL || 'http://localhost:3000'
    const slots = MAX_CONCURRENT - ((await sql`SELECT COUNT(*)::int as cnt FROM queue_jobs WHERE status = 'active'`)[0].cnt as number)
    if (slots > 0) {
      const waiting = await sql`SELECT * FROM queue_jobs WHERE status = 'waiting' ORDER BY created_at ASC LIMIT ${slots}`
      for (const row of waiting) {
        const job = rowToJob(row)
        fetch(`${base}/api/queue/start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ runId: job.runId, params: job.params }),
        }).catch(() => {})
      }
    }
  }

  const [activeRows, waitingRows, recentRows] = await Promise.all([
    sql`SELECT COUNT(*)::int as cnt FROM queue_jobs WHERE status = 'active'`,
    sql`SELECT COUNT(*)::int as cnt FROM queue_jobs WHERE status = 'waiting'`,
    sql`SELECT * FROM queue_jobs ORDER BY created_at DESC LIMIT 50`,
  ])

  return {
    active:        activeRows[0].cnt  as number,
    waiting:       waitingRows[0].cnt as number,
    maxConcurrent: MAX_CONCURRENT,
    recentJobs:    recentRows.map(rowToJob),
  }
}

export async function getQueuePosition(runId: string): Promise<number> {
  const sql = getSql()
  const rows = await sql`
    SELECT ROW_NUMBER() OVER (ORDER BY created_at ASC)::int as pos
    FROM queue_jobs
    WHERE status = 'waiting' AND run_id = ${runId}
  `
  return rows.length > 0 ? (rows[0].pos as number) : 0
}

export async function isQueueIdle(): Promise<boolean> {
  const sql = getSql()
  const rows = await sql`SELECT COUNT(*)::int as cnt FROM queue_jobs WHERE status IN ('active','waiting')`
  return (rows[0].cnt as number) === 0
}

export async function pruneOldJobs(): Promise<void> {
  const sql = getSql()
  await sql`
    DELETE FROM queue_jobs
    WHERE status IN ('completed','failed')
    AND id NOT IN (
      SELECT id FROM queue_jobs WHERE status IN ('completed','failed')
      ORDER BY COALESCE(completed_at, created_at) DESC LIMIT 200
    )
  `
}

export async function getJobByRunId(runId: string): Promise<QueueJob | undefined> {
  const sql = getSql()
  const rows = await sql`SELECT * FROM queue_jobs WHERE run_id = ${runId} ORDER BY created_at DESC LIMIT 1`
  return rows.length > 0 ? rowToJob(rows[0]) : undefined
}
