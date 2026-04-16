/**
 * DB housekeeping utilities.
 * Runs VACUUM + WAL checkpoint to reclaim disk space and keep the
 * SQLite WAL file from growing unbounded on long-running deployments.
 * Also provides pruning of old completed-job data.
 */
import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'

const DATA_DIR = path.join(process.cwd(), 'data')
const DB_FILE  = path.join(DATA_DIR, 'companies.db')

export interface MaintenanceResult {
  walCheckpointPages: number
  vacuumDone: boolean
  dbSizeBytes: number
  prunedRows?: number
}

export interface PruneOptions {
  /** Delete rows older than this many days (default: 90) */
  daysOld?: number
  /**
   * Only delete rows with these statuses (default: ['送信済み', 'スキップ'])
   * Pass [] to delete regardless of status.
   */
  statuses?: string[]
}

/**
 * Delete old company rows to keep the DB lean.
 * Only removes rows that are older than `daysOld` AND have an end-state status,
 * so in-progress or未送信 rows are never auto-deleted.
 */
export function pruneOldData(opts: PruneOptions = {}): number {
  if (!fs.existsSync(DB_FILE)) return 0

  const daysOld = opts.daysOld ?? 90
  const statuses = opts.statuses ?? ['送信済み', 'スキップ']

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - daysOld)
  const cutoffIso = cutoff.toISOString()

  const db = new Database(DB_FILE)
  db.pragma('journal_mode = WAL')
  try {
    let result: { changes: number }
    if (statuses.length === 0) {
      result = db.prepare('DELETE FROM companies WHERE collectedAt < ?').run(cutoffIso)
    } else {
      const placeholders = statuses.map(() => '?').join(', ')
      result = db.prepare(
        `DELETE FROM companies WHERE collectedAt < ? AND status IN (${placeholders})`
      ).run(cutoffIso, ...statuses)
    }
    return result.changes
  } finally {
    db.close()
  }
}

export function runMaintenance(): MaintenanceResult {
  if (!fs.existsSync(DB_FILE)) {
    return { walCheckpointPages: 0, vacuumDone: false, dbSizeBytes: 0 }
  }

  const db = new Database(DB_FILE)
  db.pragma('journal_mode = WAL')

  // Force a full WAL checkpoint so the WAL file is merged back into the main DB
  // and can be safely truncated.  Mode = TRUNCATE (not PASSIVE) so it waits for
  // readers to release their locks before writing.
  type WalRow = { busy: number; log: number; checkpointed: number }
  const walRow = db.pragma('wal_checkpoint(TRUNCATE)') as WalRow[]
  const walCheckpointPages = walRow[0]?.checkpointed ?? 0

  // VACUUM reclaims space freed by DELETE operations (e.g. after large run deletions).
  // Uses the incremental mode to avoid locking the DB for extended periods.
  db.exec('VACUUM')

  db.close()

  const dbSizeBytes = fs.statSync(DB_FILE).size

  return { walCheckpointPages, vacuumDone: true, dbSizeBytes }
}
