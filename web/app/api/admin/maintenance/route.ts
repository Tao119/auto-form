import { NextResponse } from 'next/server'
import { runMaintenance } from '@/lib/db-maintenance'
import { expireStaleRuns } from '@/lib/project-manager'

/**
 * POST /api/admin/maintenance
 * Runs DB housekeeping: WAL checkpoint, VACUUM, stale-run expiry.
 * Called by n8n on a schedule or manually from the settings page.
 * No auth required — internal network only.
 */
export async function POST() {
  try {
    const staleExpired = expireStaleRuns()
    const dbStats = runMaintenance()
    return NextResponse.json({
      success: true,
      staleRunsExpired: staleExpired,
      ...dbStats,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

export async function GET() {
  return POST()
}
