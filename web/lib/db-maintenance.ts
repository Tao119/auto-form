import getSql from './db'
import { pruneOldJobs } from './run-queue'

export interface MaintenanceResult {
  vacuumDone: boolean
  prunedRows?: number
}

export interface PruneOptions {
  daysOld?: number
  statuses?: string[]
}

export async function pruneOldData(opts: PruneOptions = {}): Promise<number> {
  const sql = getSql()
  const daysOld = opts.daysOld ?? 90
  const statuses = opts.statuses ?? ['送信済み', 'スキップ']
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - daysOld)
  const cutoffIso = cutoff.toISOString()

  let result
  if (statuses.length === 0) {
    result = await sql`DELETE FROM companies WHERE collected_at < ${cutoffIso}`
  } else {
    result = await sql`DELETE FROM companies WHERE collected_at < ${cutoffIso} AND status = ANY(${statuses})`
  }
  return result.count
}

export async function runMaintenance(): Promise<MaintenanceResult> {
  await pruneOldJobs()
  return { vacuumDone: false }
}
