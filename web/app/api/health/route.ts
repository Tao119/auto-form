import { NextResponse } from 'next/server'
import { checkN8nHealth } from '@/lib/n8n-client'

export const dynamic = 'force-dynamic'

export async function GET() {
  const n8n = await checkN8nHealth()
  return NextResponse.json({
    status: 'ok',
    n8n,
    n8nBaseUrl: process.env.N8N_BASE_URL ?? '(not set)',
    n8nWebhookPath: process.env.N8N_WEBHOOK_PATH ?? '(not set)',
  })
}
