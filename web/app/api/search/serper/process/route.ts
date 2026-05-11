import { NextRequest, NextResponse } from 'next/server'
import getSupabase from '@/lib/db'
import { runSerperSearch } from '@/lib/serper'

export const maxDuration = 300

export async function POST(req: NextRequest) {
  let jobId: string | undefined
  try {
    const body = await req.json()
    jobId = body.jobId as string
    if (!jobId) return NextResponse.json({ success: false, error: 'jobId required' }, { status: 400 })

    const apiKey = process.env.SERPER_API_KEY
    if (!apiKey) return NextResponse.json({ success: false, error: 'SERPER_API_KEY not configured' }, { status: 500 })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = getSupabase() as any

    // Fetch job params
    const { data: job, error: fetchErr } = await supabase
      .from('serper_jobs')
      .select('*')
      .eq('id', jobId)
      .single()
    if (fetchErr || !job) return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
    if (job.status !== 'queued') return NextResponse.json({ success: true, note: 'already processed' })

    // Mark running
    await supabase.from('serper_jobs').update({ status: 'running', started_at: new Date().toISOString() }).eq('id', jobId)

    const params = job.params as { keywords: string[]; area: string; suffixes?: string[] }
    const { items, error: apiErr } = await runSerperSearch({
      keywords: params.keywords,
      area: params.area,
      suffixes: params.suffixes,
      apiKey,
    })

    if (apiErr) {
      await supabase.from('serper_jobs').update({
        status: 'error',
        error: `Serper API error: ${apiErr.status} ${apiErr.text}`,
        completed_at: new Date().toISOString(),
      }).eq('id', jobId)
      return NextResponse.json({ success: false, error: apiErr.text }, { status: 502 })
    }

    await supabase.from('serper_jobs').update({
      status: 'done',
      result_count: items.length,
      result_items: items,
      completed_at: new Date().toISOString(),
    }).eq('id', jobId)

    return NextResponse.json({ success: true, count: items.length })
  } catch (e) {
    if (jobId) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const supabase = getSupabase() as any
        await supabase.from('serper_jobs').update({
          status: 'error',
          error: String(e),
          completed_at: new Date().toISOString(),
        }).eq('id', jobId)
      } catch { /* ignore */ }
    }
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}
