import { NextResponse } from 'next/server'
import { getQueueStatus, MAX_CONCURRENT, setMaxConcurrent } from '@/lib/run-queue'
import { NextRequest } from 'next/server'
import { z } from 'zod'

/** GET /api/queue — キュー全体の状態を返す */
export async function GET() {
  try {
    const status = getQueueStatus()
    return NextResponse.json({ success: true, data: status })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

/** PATCH /api/queue — 最大同時実行数を変更 */
export async function PATCH(req: NextRequest) {
  try {
    const { maxConcurrent } = z.object({ maxConcurrent: z.number().int().min(1).max(20) }).parse(await req.json())
    setMaxConcurrent(maxConcurrent)
    return NextResponse.json({ success: true, data: { maxConcurrent } })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
