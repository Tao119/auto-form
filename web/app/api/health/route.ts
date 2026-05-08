import { NextResponse } from 'next/server'
import { checkN8nHealth } from '@/lib/n8n-client'
import getSupabase from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const n8n = await checkN8nHealth()
  let supabaseRunCount: number | string = '?'
  let supabaseUrl = process.env.SUPABASE_URL ?? '(not set)'
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = getSupabase() as any
    const { count, error } = await supabase.from('project_runs').select('*', { count: 'exact', head: true })
    supabaseRunCount = error ? `error: ${error.message}` : (count ?? 0)
  } catch (e) {
    supabaseRunCount = `exception: ${String(e)}`
  }
  return NextResponse.json({
    status: 'ok',
    n8n,
    n8nBaseUrl: process.env.N8N_BASE_URL ?? '(not set)',
    n8nWebhookPath: process.env.N8N_WEBHOOK_PATH ?? '(not set)',
    supabaseUrl: supabaseUrl.slice(0, 40),
    supabaseRunCount,
  })
}
