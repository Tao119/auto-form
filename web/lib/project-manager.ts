import getSql from './db'
import type { Project, ProjectRun, SearchTarget } from './types'

// ── helper: DB row → typed objects ────────────────────────────────

function rowToProject(r: Record<string, unknown>): Project {
  return {
    id:          r.id as string,
    name:        r.name as string,
    description: r.description as string | undefined,
    createdAt:   r.created_at as string,
    runIds:      (r.run_ids as string[]) ?? [],
    sheetsId:    r.sheets_id as string | undefined,
  }
}

function rowToRun(r: Record<string, unknown>): ProjectRun {
  return {
    id:              r.id as string,
    projectId:       r.project_id as string,
    label:           r.label as string,
    createdAt:       r.created_at as string,
    searchTarget:    (r.search_target as SearchTarget) ?? {},
    status:          r.status as ProjectRun['status'],
    runType:         r.run_type as ProjectRun['runType'] | undefined,
    parentRunId:     r.parent_run_id as string | undefined,
    childRunIds:     r.child_run_ids as string[] | undefined,
    n8nExecutionId:  r.n8n_execution_id as string | undefined,
    itemsWritten:    r.items_written as number | undefined,
    completedAt:     r.completed_at as string | undefined,
    estimatedCostUsd: r.estimated_cost_usd as number | undefined,
    tokensInput:     r.tokens_input as number | undefined,
    tokensOutput:    r.tokens_output as number | undefined,
    rawSearchCount:  r.raw_search_count as number | undefined,
    results:         r.results as ProjectRun['results'] | undefined,
    error:           r.error as string | undefined,
  }
}

// ─── Projects ──────────────────────────────────────────────────────

export async function getProjects(): Promise<Project[]> {
  const sql = getSql()
  const rows = await sql`SELECT * FROM projects ORDER BY created_at DESC`
  return rows.map(rowToProject)
}

export async function getProject(id: string): Promise<Project | undefined> {
  const sql = getSql()
  const rows = await sql`SELECT * FROM projects WHERE id = ${id}`
  return rows.length > 0 ? rowToProject(rows[0]) : undefined
}

export async function createProject(name: string, description?: string): Promise<Project> {
  const sql = getSql()
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const existing = await sql`SELECT id FROM projects WHERE id LIKE ${'proj-' + today + '%'}`
  const seq = String(existing.length + 1).padStart(3, '0')
  const project: Project = {
    id:          `proj-${today}-${seq}`,
    name,
    description,
    createdAt:   new Date().toISOString(),
    runIds:      [],
  }
  await sql`
    INSERT INTO projects (id, name, description, created_at, run_ids)
    VALUES (${project.id}, ${project.name}, ${project.description ?? null}, ${project.createdAt}, ${sql.json([])})
  `
  return project
}

export async function linkSheets(projectId: string, sheetsId: string): Promise<Project> {
  const sql = getSql()
  await sql`UPDATE projects SET sheets_id = ${sheetsId} WHERE id = ${projectId}`
  const p = await getProject(projectId)
  if (!p) throw new Error(`Project ${projectId} not found`)
  return p
}

export async function deleteProject(id: string): Promise<void> {
  const sql = getSql()
  await sql`DELETE FROM projects WHERE id = ${id}`
}

export async function deleteRun(runId: string): Promise<string | null> {
  const sql = getSql()
  const run = await getProjectRun(runId)
  if (!run) return null

  await sql`DELETE FROM project_runs WHERE id = ${runId}`
  await sql`
    UPDATE projects
    SET run_ids = (
      SELECT jsonb_agg(elem)
      FROM jsonb_array_elements_text(run_ids) elem
      WHERE elem != ${runId}
    )
    WHERE id = ${run.projectId}
  `
  return runId
}

// ─── Runs ──────────────────────────────────────────────────────────

export async function getRunsForProject(projectId: string): Promise<ProjectRun[]> {
  const sql = getSql()
  const rows = await sql`
    SELECT * FROM project_runs
    WHERE project_id = ${projectId}
    ORDER BY created_at DESC
  `
  return rows.map(rowToRun)
}

export async function getProjectRun(runId: string): Promise<ProjectRun | undefined> {
  const sql = getSql()
  const rows = await sql`SELECT * FROM project_runs WHERE id = ${runId}`
  return rows.length > 0 ? rowToRun(rows[0]) : undefined
}

export async function addRunToProject(
  projectId: string,
  run: { id: string; label: string; searchTarget: SearchTarget }
): Promise<ProjectRun> {
  const sql = getSql()
  const projectRun: ProjectRun = {
    id:           run.id,
    projectId,
    label:        run.label,
    createdAt:    new Date().toISOString(),
    searchTarget: run.searchTarget,
    status:       'pending',
  }
  await sql`
    INSERT INTO project_runs (id, project_id, label, created_at, search_target, status)
    VALUES (${projectRun.id}, ${projectId}, ${projectRun.label}, ${projectRun.createdAt}, ${sql.json(run.searchTarget as unknown as Parameters<typeof sql.json>[0])}, 'pending')
  `
  await sql`
    UPDATE projects
    SET run_ids = run_ids || ${sql.json([run.id])}::jsonb
    WHERE id = ${projectId} AND NOT (run_ids @> ${sql.json([run.id])}::jsonb)
  `
  return projectRun
}

export async function addBatchRunToProject(
  projectId: string,
  parent: { id: string; label: string; searchTarget: SearchTarget },
  children: { id: string; area: string; label: string }[],
): Promise<{ parent: ProjectRun; children: ProjectRun[] }> {
  const sql = getSql()

  const childRuns: ProjectRun[] = children.map((c) => ({
    id:           c.id,
    projectId,
    label:        c.label,
    createdAt:    new Date().toISOString(),
    searchTarget: { ...parent.searchTarget, area: c.area, areas: undefined },
    status:       'pending' as const,
    runType:      'child' as const,
    parentRunId:  parent.id,
  }))

  const parentRun: ProjectRun = {
    id:           parent.id,
    projectId,
    label:        parent.label,
    createdAt:    new Date().toISOString(),
    searchTarget: parent.searchTarget,
    status:       'pending',
    runType:      'batch',
    childRunIds:  children.map((c) => c.id),
  }

  await sql`
    INSERT INTO project_runs (id, project_id, label, created_at, search_target, status, run_type, child_run_ids)
    VALUES (
      ${parentRun.id}, ${projectId}, ${parentRun.label}, ${parentRun.createdAt},
      ${sql.json(parent.searchTarget as unknown as Parameters<typeof sql.json>[0])}, 'pending', 'batch',
      ${sql.json(children.map(c => c.id))}
    )
  `
  for (const c of childRuns) {
    await sql`
      INSERT INTO project_runs (id, project_id, label, created_at, search_target, status, run_type, parent_run_id)
      VALUES (
        ${c.id}, ${projectId}, ${c.label}, ${c.createdAt},
        ${sql.json(c.searchTarget as unknown as Parameters<typeof sql.json>[0])}, 'pending', 'child', ${parent.id}
      )
    `
  }
  await sql`
    UPDATE projects
    SET run_ids = run_ids || ${sql.json([parent.id])}::jsonb
    WHERE id = ${projectId} AND NOT (run_ids @> ${sql.json([parent.id])}::jsonb)
  `
  return { parent: parentRun, children: childRuns }
}

export async function rollupBatchRun(parentRunId: string): Promise<void> {
  const sql = getSql()
  const parentRows = await sql`SELECT * FROM project_runs WHERE id = ${parentRunId}`
  if (parentRows.length === 0) return
  const parent = rowToRun(parentRows[0])
  if (!parent.childRunIds?.length) return

  const childRows = await sql`SELECT * FROM project_runs WHERE id = ANY(${parent.childRunIds})`
  const children = childRows.map(rowToRun)

  const allTerminal = children.every(c => c.status === 'success' || c.status === 'completed' || c.status === 'error')
  if (!allTerminal) return

  const currentSum = children.reduce((s, c) => s + (c.itemsWritten ?? 0), 0)
  if ((parent.status === 'success' || parent.status === 'completed') && parent.itemsWritten === currentSum && parent.completedAt) return

  const totalItems     = children.reduce((s, c) => s + (c.itemsWritten        ?? 0), 0)
  const totalCost      = children.reduce((s, c) => s + (c.estimatedCostUsd    ?? 0), 0)
  const totalTokIn     = children.reduce((s, c) => s + (c.tokensInput         ?? 0), 0)
  const totalTokOut    = children.reduce((s, c) => s + (c.tokensOutput        ?? 0), 0)
  const totalRawSearch = children.reduce((s, c) => s + (c.rawSearchCount      ?? 0), 0)
  const hasSuccess     = children.some(c => c.status === 'success' || c.status === 'completed')

  await sql`
    UPDATE project_runs SET
      status            = ${hasSuccess ? 'success' : 'error'},
      items_written     = ${totalItems},
      completed_at      = ${new Date().toISOString()},
      estimated_cost_usd = ${totalCost > 0 ? totalCost : null},
      tokens_input      = ${totalTokIn > 0 ? totalTokIn : null},
      tokens_output     = ${totalTokOut > 0 ? totalTokOut : null},
      raw_search_count  = ${totalRawSearch > 0 ? totalRawSearch : null}
    WHERE id = ${parentRunId}
  `
}

export async function getChildRuns(parentRunId: string): Promise<ProjectRun[]> {
  const sql = getSql()
  const rows = await sql`SELECT * FROM project_runs WHERE parent_run_id = ${parentRunId}`
  return rows.map(rowToRun)
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

export async function expireStaleRuns(
  runningMaxAgeMs = 2 * 60 * 60 * 1000,
  pendingMaxAgeMs = 24 * 60 * 60 * 1000,
): Promise<number> {
  const sql = getSql()
  const now = new Date()
  const runningCutoff = new Date(now.getTime() - runningMaxAgeMs).toISOString()
  const pendingCutoff  = new Date(now.getTime() - pendingMaxAgeMs).toISOString()

  const result = await sql`
    UPDATE project_runs SET
      status       = 'error',
      completed_at = COALESCE(completed_at, ${now.toISOString()})
    WHERE (status = 'running' AND created_at < ${runningCutoff})
       OR (status = 'pending' AND created_at < ${pendingCutoff})
  `
  return result.count
}

export async function updateRunStatus(
  runId: string,
  status: ProjectRun['status'],
  n8nExecutionId?: string,
  itemsWritten?: number,
  extra?: RunStatusUpdate
): Promise<void> {
  const sql = getSql()
  await sql`
    UPDATE project_runs SET
      status             = ${status},
      n8n_execution_id   = COALESCE(${n8nExecutionId ?? null}, n8n_execution_id),
      items_written      = COALESCE(${itemsWritten     ?? null}, items_written),
      tokens_input       = COALESCE(${extra?.tokensInput      ?? null}, tokens_input),
      tokens_output      = COALESCE(${extra?.tokensOutput     ?? null}, tokens_output),
      estimated_cost_usd = COALESCE(${extra?.estimatedCostUsd ?? null}, estimated_cost_usd),
      completed_at       = COALESCE(${extra?.completedAt      ?? null}, completed_at),
      raw_search_count   = COALESCE(${extra?.rawSearchCount   ?? null}, raw_search_count),
      results            = COALESCE(${extra?.results ? sql.json(extra.results as unknown as Parameters<typeof sql.json>[0]) : null}, results),
      error              = COALESCE(${extra?.error             ?? null}, error)
    WHERE id = ${runId}
  `
}
