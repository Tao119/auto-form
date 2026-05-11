import { NextRequest, NextResponse } from 'next/server'
import getSupabase from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest, { params }: { params: { jobId: string } }) {
  try {
    const { jobId } = params
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = getSupabase() as any
    const { data: job, error } = await supabase
      .from('serper_jobs')
      .select('id, status, result_count, result_items, error, created_at, started_at, completed_at')
      .eq('id', jobId)
      .single()

    if (error || !job) {
      return NextResponse.json({ success: false, error: 'Job not found' }, { status: 404 })
    }

    const base = {
      success: true,
      jobId,
      status: job.status as string,
      createdAt: job.created_at,
      startedAt: job.started_at,
      completedAt: job.completed_at,
    }

    if (job.status === 'done') {
      return NextResponse.json({
        ...base,
        count: job.result_count,
        items: job.result_items,
      })
    }

    if (job.status === 'error') {
      return NextResponse.json({ ...base, error: job.error }, { status: 200 })
    }

    return NextResponse.json(base)
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}
