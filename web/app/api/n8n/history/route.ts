import { NextRequest, NextResponse } from 'next/server'
import { listExecutions } from '@/lib/n8n-client'

export async function GET(req: NextRequest) {
  const limit = parseInt(req.nextUrl.searchParams.get('limit') || '30', 10)

  try {
    const result = await listExecutions(limit)
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ success: false, error: msg }, { status: 500 })
  }
}
