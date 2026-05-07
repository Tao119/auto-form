import { NextResponse } from 'next/server'
import { getQueueStatus, MAX_CONCURRENT } from '@/lib/run-queue'

export const dynamic = 'force-dynamic'

/** GET /api/queue — キュー全体の状態を返す */
export async function GET() {
  try {
    const status = await getQueueStatus()
    return NextResponse.json({ success: true, data: status })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

/**
 * PATCH /api/queue — かつて最大同時実行数を変更可能だったが、
 * 環境変数 MAX_CONCURRENT_RUNS による起動時固定方式に変わったため、
 * 互換性のため405を返す。
 */
export async function PATCH() {
  return NextResponse.json(
    { success: false, error: '同時実行数の動的変更は無効化されました。環境変数 MAX_CONCURRENT_RUNS を使用してください。', maxConcurrent: MAX_CONCURRENT },
    { status: 405 },
  )
}
