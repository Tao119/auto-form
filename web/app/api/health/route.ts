import { NextResponse } from 'next/server'
import { checkN8nHealth } from '@/lib/n8n-client'

export const dynamic = 'force-dynamic'

export async function GET() {
  const n8n = await checkN8nHealth()
  return NextResponse.json({ status: 'ok', n8n })
}
