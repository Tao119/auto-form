import { NextResponse } from 'next/server'
import { syncAllRunningJobs } from '@/lib/n8n-sync'

/**
 * POST /api/projects/runs/sync
 * 全実行中ランのステータスをn8nから同期する。
 * ページ読み込み時や定期ポーリングから呼ばれる。
 */
export async function POST() {
  try {
    const result = await syncAllRunningJobs()
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}
