import fs from 'fs'
import path from 'path'
import type { QueueJob, QueueData, ExecuteParams } from './types'
import { updateRunStatus, expireStaleRuns } from './project-manager'

const DATA_DIR = path.join(process.cwd(), 'data')
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json')

export const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_RUNS || '3', 10)

// ─── Startup recovery ─────────────────────────────────────────
// Run once per process to reset any jobs that were 'active' when the server
// last stopped (they will never receive their completion callback).
let _startupRecoveryDone = false

function recoverStaleActiveJobs(data: QueueData): void {
  const stale = data.jobs.filter((j) => j.status === 'active')
  if (stale.length === 0) return

  for (const job of stale) {
    job.status = 'failed'
    job.completedAt = new Date().toISOString()
    job.error = 'server_restart'
    updateRunStatus(job.runId, 'error')
  }
}

// ─── File I/O ─────────────────────────────────────────────────

function readQueue(): QueueData {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  const blank: QueueData = { jobs: [], maxConcurrent: MAX_CONCURRENT }
  if (!fs.existsSync(QUEUE_FILE)) {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(blank, null, 2))
    _startupRecoveryDone = true
    return blank
  }
  let data: QueueData
  try {
    data = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')) as QueueData
    // Sanity check
    if (!Array.isArray(data.jobs)) data = blank
  } catch {
    // Corrupted file — reset to blank (stale recovery runs next time)
    data = blank
  }
  if (!_startupRecoveryDone) {
    _startupRecoveryDone = true
    recoverStaleActiveJobs(data)
    writeQueue(data)
  }
  return data
}

function writeQueue(data: QueueData): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = QUEUE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, QUEUE_FILE)
}

// ─── Public API ───────────────────────────────────────────────

/** Add a job to the queue. Returns the job and whether it can start immediately. */
export function enqueue(runId: string, projectId: string, params: ExecuteParams): {
  job: QueueJob
  canStart: boolean
  queuePosition: number
} {
  const data = readQueue()
  const activeCount = data.jobs.filter((j) => j.status === 'active').length
  const waitingCount = data.jobs.filter((j) => j.status === 'waiting').length
  const canStart = activeCount < (data.maxConcurrent || MAX_CONCURRENT)

  const job: QueueJob = {
    runId,
    projectId,
    params,
    status: canStart ? 'active' : 'waiting',
    createdAt: new Date().toISOString(),
  }

  data.jobs.push(job)
  writeQueue(data)

  return {
    job,
    canStart,
    queuePosition: canStart ? 0 : waitingCount + 1,
  }
}

/** Mark a job as active (started). */
export function markJobActive(runId: string): void {
  const data = readQueue()
  const job = data.jobs.find((j) => j.runId === runId)
  if (job) {
    job.status = 'active'
    job.startedAt = new Date().toISOString()
  }
  writeQueue(data)
}

/** Mark a job as completed or failed, and return the next waiting job (if any). */
export function markJobDone(runId: string, status: 'completed' | 'failed', error?: string): QueueJob | undefined {
  const data = readQueue()
  const job = data.jobs.find((j) => j.runId === runId)
  if (job) {
    job.status = status
    job.completedAt = new Date().toISOString()
    if (error) job.error = error
  }

  // Only start next job if we're below the concurrency limit (prevents race condition)
  const activeCount = data.jobs.filter((j) => j.status === 'active').length
  const maxConcurrent = data.maxConcurrent || MAX_CONCURRENT
  if (activeCount >= maxConcurrent) {
    writeQueue(data)
    return undefined
  }

  // Find next waiting job
  const next = data.jobs.find((j) => j.status === 'waiting')
  if (next) {
    next.status = 'active'
    next.startedAt = new Date().toISOString()
  }

  writeQueue(data)
  return next
}

/** Get full queue status. Also expires stale project runs (> 2 h in 'running') and prunes old jobs. */
export function getQueueStatus(): {
  active: number
  waiting: number
  maxConcurrent: number
  recentJobs: QueueJob[]
} {
  expireStaleRuns()
  pruneOldJobs()
  const data = readQueue()
  const active = data.jobs.filter((j) => j.status === 'active').length
  const waiting = data.jobs.filter((j) => j.status === 'waiting').length

  // Return recent jobs (last 50, sorted newest first)
  const recentJobs = [...data.jobs]
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50)

  return {
    active,
    waiting,
    maxConcurrent: data.maxConcurrent || MAX_CONCURRENT,
    recentJobs,
  }
}

/** Get the current max concurrent setting. */
export function getMaxConcurrent(): number {
  const data = readQueue()
  return data.maxConcurrent || MAX_CONCURRENT
}

/** Update max concurrent setting. */
export function setMaxConcurrent(n: number): void {
  const data = readQueue()
  data.maxConcurrent = Math.max(1, Math.min(20, n))
  writeQueue(data)
}

/** Get queue position (1-based) for a waiting job, or 0 if active/not found. */
export function getQueuePosition(runId: string): number {
  const data = readQueue()
  const waitingJobs = data.jobs
    .filter((j) => j.status === 'waiting')
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
  const idx = waitingJobs.findIndex((j) => j.runId === runId)
  return idx === -1 ? 0 : idx + 1
}

/** Prune old completed/failed jobs (keep last 200). */
export function pruneOldJobs(): void {
  const data = readQueue()
  const done = data.jobs.filter((j) => j.status === 'completed' || j.status === 'failed')
  if (done.length > 200) {
    const keep = new Set(
      done
        .sort((a, b) => new Date(b.completedAt || b.createdAt).getTime() - new Date(a.completedAt || a.createdAt).getTime())
        .slice(0, 200)
        .map((j) => j.runId)
    )
    data.jobs = data.jobs.filter((j) => j.status === 'active' || j.status === 'waiting' || keep.has(j.runId))
    writeQueue(data)
  }
}
