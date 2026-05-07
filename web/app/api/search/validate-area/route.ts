import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

export const dynamic = 'force-dynamic'

const Schema = z.object({ area: z.string().min(1).max(100) })

export async function POST(req: NextRequest) {
  try {
    const { area } = Schema.parse(await req.json())
    const apiKey = process.env.SERPER_API_KEY
    if (!apiKey) {
      return NextResponse.json({ valid: true, normalized: area })
    }

    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: { 'X-API-KEY': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: `${area} 住所 地名`, gl: 'jp', hl: 'ja', num: 3 }),
    })

    if (!res.ok) {
      // API error → assume valid (don't block on API failure)
      return NextResponse.json({ valid: true, normalized: area })
    }

    const data = await res.json() as {
      organic?: { title: string; link: string }[]
      knowledgeGraph?: { title?: string; type?: string }
      answerBox?: { answer?: string }
    }

    // If Serper returns 0 organic results and no knowledge graph, it's likely not a real place
    const hasResults = (data.organic?.length ?? 0) > 0
    const hasKG = !!data.knowledgeGraph?.title
    const valid = hasResults || hasKG

    // Try to extract normalized name from knowledge graph
    const normalized = data.knowledgeGraph?.title ?? area

    return NextResponse.json({ valid, normalized })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
