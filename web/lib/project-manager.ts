import fs from 'fs'
import path from 'path'
import type { Project, ProjectRun, ProjectsData, SearchTarget } from './types'

const DATA_DIR = path.join(process.cwd(), 'data')
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify({ projects: [], runs: [] }, null, 2))
  }
}

function readData(): ProjectsData {
  ensureFile()
  try {
    const data = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf-8')) as ProjectsData
    if (!Array.isArray(data.projects) || !Array.isArray(data.runs)) {
      throw new Error('invalid structure')
    }
    return data
  } catch {
    // Corrupted file — reinitialise (data loss is preferable to a crash loop)
    const blank: ProjectsData = { projects: [], runs: [] }
    writeData(blank)
    return blank
  }
}

function writeData(data: ProjectsData): void {
  ensureFile()
  const tmp = PROJECTS_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, PROJECTS_FILE)
}

// ─── Projects ─────────────────────────────────────────────────

export function getProjects(): Project[] {
  return readData().projects
}

export function getProject(id: string): Project | undefined {
  return readData().projects.find((p) => p.id === id)
}

export function createProject(name: string, description?: string): Project {
  const data = readData()
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const existing = data.projects.filter((p) => p.id.startsWith(`proj-${today}`))
  const seq = String(existing.length + 1).padStart(3, '0')
  const project: Project = {
    id: `proj-${today}-${seq}`,
    name,
    description,
    createdAt: new Date().toISOString(),
    runIds: [],
  }
  data.projects.unshift(project)
  writeData(data)
  return project
}

export function linkSheets(projectId: string, sheetsId: string): Project {
  const data = readData()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)
  project.sheetsId = sheetsId
  writeData(data)
  return project
}

export function deleteProject(id: string): void {
  const data = readData()
  const project = data.projects.find((p) => p.id === id)
  if (!project) return
  data.projects = data.projects.filter((p) => p.id !== id)
  data.runs = data.runs.filter((r) => r.projectId !== id)
  writeData(data)
}

/** Remove a single run from its project. Returns the runId if found. */
export function deleteRun(runId: string): string | null {
  const data = readData()
  const run = data.runs.find((r) => r.id === runId)
  if (!run) return null
  data.runs = data.runs.filter((r) => r.id !== runId)
  const project = data.projects.find((p) => p.id === run.projectId)
  if (project) {
    project.runIds = project.runIds.filter((id) => id !== runId)
  }
  writeData(data)
  return runId
}

// ─── Runs ──────────────────────────────────────────────────────

export function getRunsForProject(projectId: string): ProjectRun[] {
  return readData().runs
    .filter((r) => r.projectId === projectId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export function getProjectRun(runId: string): ProjectRun | undefined {
  return readData().runs.find((r) => r.id === runId)
}

export function addRunToProject(
  projectId: string,
  run: { id: string; label: string; searchTarget: SearchTarget }
): ProjectRun {
  const data = readData()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)

  const projectRun: ProjectRun = {
    id: run.id,
    projectId,
    label: run.label,
    createdAt: new Date().toISOString(),
    searchTarget: run.searchTarget,
    status: 'pending',
  }

  data.runs.push(projectRun)
  if (!project.runIds.includes(run.id)) {
    project.runIds.push(run.id)
  }
  writeData(data)
  return projectRun
}

/**
 * Create a batch parent run + N child runs (one per area) atomically.
 * The parent run is added to the project's runIds; children are NOT
 * (they are hidden from history via parentRunId).
 */
export function addBatchRunToProject(
  projectId: string,
  parent: { id: string; label: string; searchTarget: SearchTarget },
  children: { id: string; area: string; label: string }[],
): { parent: ProjectRun; children: ProjectRun[] } {
  const data = readData()
  const project = data.projects.find((p) => p.id === projectId)
  if (!project) throw new Error(`Project ${projectId} not found`)

  const childRuns: ProjectRun[] = children.map((c) => ({
    id: c.id,
    projectId,
    label: c.label,
    createdAt: new Date().toISOString(),
    searchTarget: {
      ...parent.searchTarget,
      area: c.area,
      areas: undefined,
    },
    status: 'pending' as const,
    runType: 'child' as const,
    parentRunId: parent.id,
  }))

  const parentRun: ProjectRun = {
    id: parent.id,
    projectId,
    label: parent.label,
    createdAt: new Date().toISOString(),
    searchTarget: parent.searchTarget,
    status: 'pending',
    runType: 'batch',
    childRunIds: children.map((c) => c.id),
  }

  data.runs.push(parentRun, ...childRuns)
  if (!project.runIds.includes(parent.id)) project.runIds.push(parent.id)
  writeData(data)

  return { parent: parentRun, children: childRuns }
}

/**
 * Roll up child run stats into the parent batch run.
 * Only completes the parent once all children are in a terminal status.
 * Safe to call multiple times (idempotent once parent is terminal).
 */
export function rollupBatchRun(parentRunId: string): void {
  const data = readData()
  const parent = data.runs.find((r) => r.id === parentRunId)
  // parentRunId must exist and be a batch run. Never re-rollup a parent that's already fully settled
  // (both status AND completedAt set by a prior rollup invocation).
  if (!parent || !parent.childRunIds) return
  // Allow re-rollup if parent was prematurely marked terminal by something other than rollup
  // (e.g. queue auto-start set it 'success' before all children finished).
  // The check: only skip if completedAt was already set by a prior complete rollup.
  // We detect a "real" rollup completion by checking that itemsWritten matches the child sum.
  const children = data.runs.filter((r) => parent.childRunIds!.includes(r.id))
  const allTerminal = children.every(
    (c) => c.status === 'success' || c.status === 'completed' || c.status === 'error',
  )
  if (!allTerminal) return
  // Already correctly rolled up: all children terminal and sum matches
  const currentSum = children.reduce((s, c) => s + (c.itemsWritten ?? 0), 0)
  if (
    (parent.status === 'success' || parent.status === 'completed') &&
    parent.itemsWritten === currentSum &&
    parent.completedAt
  ) return

  const totalItems     = children.reduce((s, c) => s + (c.itemsWritten ?? 0), 0)
  const totalCost      = children.reduce((s, c) => s + (c.estimatedCostUsd ?? 0), 0)
  const totalTokIn     = children.reduce((s, c) => s + (c.tokensInput ?? 0), 0)
  const totalTokOut    = children.reduce((s, c) => s + (c.tokensOutput ?? 0), 0)
  const totalRawSearch = children.reduce((s, c) => s + (c.rawSearchCount ?? 0), 0)
  const hasSuccess     = children.some((c) => c.status === 'success' || c.status === 'completed')

  parent.status          = hasSuccess ? 'success' : 'error'
  parent.itemsWritten    = totalItems
  parent.completedAt     = new Date().toISOString()
  if (totalCost > 0)      parent.estimatedCostUsd = totalCost
  if (totalTokIn > 0)     parent.tokensInput      = totalTokIn
  if (totalTokOut > 0)    parent.tokensOutput     = totalTokOut
  if (totalRawSearch > 0) parent.rawSearchCount   = totalRawSearch

  writeData(data)
}

/** Return all child runs for a given batch parent run ID. */
export function getChildRuns(parentRunId: string): ProjectRun[] {
  return readData().runs.filter((r) => r.parentRunId === parentRunId)
}

export interface RunStatusUpdate {
  tokensInput?: number
  tokensOutput?: number
  estimatedCostUsd?: number
  completedAt?: string
  rawSearchCount?: number
  results?: import('./types').BenchmarkResults
  error?: string
}

/**
 * Mark runs that have been in 'running' state for longer than maxAgeMs as 'error'.
 * Called lazily from getQueueStatus to keep stale runs from blocking the UI.
 */
export function expireStaleRuns(
  runningMaxAgeMs = 2 * 60 * 60 * 1000,   // 2h for running (n8n should finish by then)
  pendingMaxAgeMs = 24 * 60 * 60 * 1000,  // 24h for pending (queue stale guard)
): number {
  const data = readData()
  const now = Date.now()
  const runningCutoff = new Date(now - runningMaxAgeMs)
  const pendingCutoff = new Date(now - pendingMaxAgeMs)
  let count = 0
  for (const run of data.runs) {
    const createdAt = new Date(run.createdAt)
    if (run.status === 'running' && createdAt < runningCutoff) {
      run.status = 'error'
      if (!run.completedAt) run.completedAt = new Date().toISOString()
      count++
    } else if (run.status === 'pending' && createdAt < pendingCutoff) {
      run.status = 'error'
      if (!run.completedAt) run.completedAt = new Date().toISOString()
      count++
    }
  }
  if (count > 0) writeData(data)
  return count
}

export function updateRunStatus(
  runId: string,
  status: ProjectRun['status'],
  n8nExecutionId?: string,
  itemsWritten?: number,
  extra?: RunStatusUpdate
): void {
  const data = readData()
  const run = data.runs.find((r) => r.id === runId)
  if (!run) return
  run.status = status
  if (n8nExecutionId !== undefined) run.n8nExecutionId = n8nExecutionId
  if (itemsWritten !== undefined) run.itemsWritten = itemsWritten
  if (extra?.tokensInput !== undefined) run.tokensInput = extra.tokensInput
  if (extra?.tokensOutput !== undefined) run.tokensOutput = extra.tokensOutput
  if (extra?.estimatedCostUsd !== undefined) run.estimatedCostUsd = extra.estimatedCostUsd
  if (extra?.completedAt !== undefined) run.completedAt = extra.completedAt
  if (extra?.rawSearchCount !== undefined) run.rawSearchCount = extra.rawSearchCount
  if (extra?.results !== undefined) run.results = extra.results
  if (extra?.error !== undefined) run.error = extra.error
  writeData(data)
}
