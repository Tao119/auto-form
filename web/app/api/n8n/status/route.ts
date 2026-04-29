import { NextRequest, NextResponse } from 'next/server'
import { getExecution } from '@/lib/n8n-client'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const executionId = req.nextUrl.searchParams.get('executionId')
  if (!executionId) {
    return NextResponse.json({ success: false, error: 'executionId required' }, { status: 400 })
  }

  try {
    const exec = await getExecution(executionId)
    // Extract item count from last write node output
    let itemsWritten = 0
    try {
      const runData = exec.data?.resultData?.runData
      if (runData) {
        const sheetsNode = runData['L-06: スプシ自動書き込み']
        if (Array.isArray(sheetsNode) && sheetsNode.length > 0) {
          const nodeData = sheetsNode[0] as { data?: { main?: unknown[][] } }
          itemsWritten = nodeData?.data?.main?.[0]?.length ?? 0
        }
      }
    } catch { /* ignore parse errors */ }

    return NextResponse.json({
      success: true,
      id: exec.id,
      status: exec.status,
      finished: exec.finished,
      startedAt: exec.startedAt,
      stoppedAt: exec.stoppedAt,
      itemsWritten,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
