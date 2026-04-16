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

export function deleteProject(id: string): void {
  const data = readData()
  const project = data.projects.find((p) => p.id === id)
  if (!project) return
  data.projects = data.projects.filter((p) => p.id !== id)
  data.runs = data.runs.filter((r) => r.projectId !== id)
  writeData(data)
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
export function expireStaleRuns(maxAgeMs = 2 * 60 * 60 * 1000): number {
  const data = readData()
  const cutoff = new Date(Date.now() - maxAgeMs)
  let count = 0
  for (const run of data.runs) {
    if (run.status === 'running' && new Date(run.createdAt) < cutoff) {
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
