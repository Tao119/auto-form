import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'

const Schema = z.object({
  keywords: z.array(z.string()).min(1),
  area:     z.string().min(1),
  maxResults: z.number().int().min(0).default(50),  // 0 or large number = unlimited (200/keyword max)
})

type CseItem = {
  title: string
  link:  string
  snippet?: string
}

export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json())
    const apiKey   = process.env.GOOGLE_SEARCH_API_KEY
    const engineId = process.env.GOOGLE_SEARCH_ENGINE_ID
    if (!apiKey || !engineId) {
      return NextResponse.json({ success: false, error: 'GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_ENGINE_ID not configured' }, { status: 500 })
    }

    const allItems: { title: string; link: string; snippet: string; keyword: string }[] = []
    const seen = new Set<string>()

    const effectiveMax = (body.maxResults === 0 || body.maxResults > 200) ? 200 : body.maxResults
    const pagesPerKw = Math.ceil(effectiveMax / 10)

    for (const kw of body.keywords) {
      const query = `${kw} ${body.area}`

      for (let page = 0; page < pagesPerKw; page++) {
        const start = page * 10 + 1
        const url = `https://www.googleapis.com/customsearch/v1?key=${apiKey}&cx=${engineId}&q=${encodeURIComponent(query)}&lr=lang_ja&gl=jp&num=10&start=${start}`

        const res = await fetch(url)
        if (!res.ok) {
          const errText = await res.text()
          return NextResponse.json({ success: false, error: `CSE API error: ${res.status} ${errText}` }, { status: 502 })
        }

        const data = await res.json() as { error?: { message: string }; items?: CseItem[] }
        if (data.error) {
          return NextResponse.json({ success: false, error: data.error.message }, { status: 502 })
        }

        const items = data.items ?? []
        for (const item of items) {
          const link = item.link || ''
          try {
            const host = new URL(link).hostname.replace(/^www\./, '')
            if (seen.has(host)) continue
            seen.add(host)
          } catch { continue }
          allItems.push({ title: item.title || '', link, snippet: item.snippet || '', keyword: kw })
        }
        if (items.length < 10) break
      }
    }

    return NextResponse.json({ success: true, items: allItems, count: allItems.length })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
