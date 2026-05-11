import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import getSupabase from '@/lib/db'

export const maxDuration = 60

const Schema = z.object({
  keywords:   z.array(z.string()).default([]),
  industry:   z.string().optional(),
  area:       z.string().min(1),
  maxResults: z.number().int().min(0).default(0),
  suffixes:   z.array(z.string()).optional(),
})

export async function POST(req: NextRequest) {
  try {
    const raw = Schema.parse(await req.json())
    const effectiveKeywords = raw.keywords.length > 0
      ? raw.keywords
      : raw.industry ? [raw.industry] : raw.keywords
    const body = { ...raw, keywords: effectiveKeywords }
    if (body.keywords.length === 0) {
      return NextResponse.json({ success: false, error: 'keywords or industry is required' }, { status: 400 })
    }

    const jobId = `sj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase = getSupabase() as any
    const { error: dbErr } = await supabase.from('serper_jobs').insert({
      id: jobId,
      status: 'queued',
      params: body,
    })
    if (dbErr) throw new Error(dbErr.message)

    // Fire-and-forget: kick off the processor (don't await)
    const base = process.env.INTERNAL_BASE_URL || 'http://localhost:3000'
    fetch(`${base}/api/search/serper/process`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId }),
    }).catch(() => {/* best-effort */})

    return NextResponse.json({ success: true, jobId, status: 'queued' })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
