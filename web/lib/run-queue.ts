import fs from 'fs'
import path from 'path'
import type { QueueJob, QueueData, ExecuteParams } from './types'

const DATA_DIR = path.join(process.cwd(), 'data')
const QUEUE_FILE = path.join(DATA_DIR, 'queue.json')

export const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT_RUNS || '3', 10)

// ─── File I/O ─────────────────────────────────────────────────

function readQueue(): QueueData {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(QUEUE_FILE)) {
    const init: QueueData = { jobs: [], maxConcurrent: MAX_CONCURRENT }
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(init, null, 2))
    return init
  }
  return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8')) as QueueData
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

/** Get full queue status. */
export function getQueueStatus(): {
  active: number
  waiting: number
  maxConcurrent: number
  recentJobs: QueueJob[]
} {
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
