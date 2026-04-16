import { NextRequest, NextResponse } from 'next/server'
import { runMaintenance, pruneOldData } from '@/lib/db-maintenance'
import { expireStaleRuns } from '@/lib/project-manager'

/**
 * POST /api/admin/maintenance
 * Runs DB housekeeping: WAL checkpoint, VACUUM, stale-run expiry.
 * Optionally prunes old completed-job rows.
 *
 * Body (all optional):
 *   { prune?: boolean, daysOld?: number, statuses?: string[] }
 *
 * Called by n8n on a schedule or manually from the settings page.
 * No auth required — internal network only.
 */
export async function POST(req: NextRequest) {
  try {
    let pruneOpts: { prune?: boolean; daysOld?: number; statuses?: string[] } = {}
    try { pruneOpts = await req.json() } catch { /* no body or non-JSON — ignore */ }

    const staleExpired = expireStaleRuns()
    const dbStats = runMaintenance()

    let prunedRows = 0
    if (pruneOpts.prune) {
      prunedRows = pruneOldData({
        daysOld: pruneOpts.daysOld,
        statuses: pruneOpts.statuses,
      })
    }

    return NextResponse.json({
      success: true,
      staleRunsExpired: staleExpired,
      prunedRows,
      ...dbStats,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

export async function GET() {
  try {
    const staleExpired = expireStaleRuns()
    const dbStats = runMaintenance()
    return NextResponse.json({ success: true, staleRunsExpired: staleExpired, ...dbStats })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}
