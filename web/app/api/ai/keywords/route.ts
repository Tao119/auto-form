import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'

const Schema = z.object({ industry: z.string().min(1).max(100) })

const cache = new Map<string, string[]>()

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openai
}

/**
 * POST /api/ai/keywords
 * 業種名からGoogleマップ検索に使う最適なキーワード候補をGPT-4o-miniで生成する。
 */
export async function POST(req: NextRequest) {
  try {
    const { industry } = Schema.parse(await req.json())

    const cached = cache.get(industry)
    if (cached) return NextResponse.json({ success: true, keywords: cached })

    const openai = getOpenAI()
    if (!openai) {
      return NextResponse.json({ success: false, error: 'OpenAI API key not configured' }, { status: 500 })
    }

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'あなたはGoogleマップで日本の店舗・施設を網羅的に検索するためのキーワード設計のエキスパートです。JSONのみ返してください。',
        },
        {
          role: 'user',
          content: `業種「${industry}」をGoogleマップで検索するキーワードを提案してください。

【絶対ルール】配列の要素数は最大3個。3個を超えることは禁止。

背景知識：
- Google Places APIは1クエリあたり最大20件しか返さない
- 類語（美容室/ヘアサロン/美容院など）は同一店舗の重複ヒットになるだけ。コスト効率が悪化する
- 実測: 美容室1kw=40件/$ vs 8kw=14件/$（多いほど悪化）

選定基準：
- メインキーワード1個（最大検索ボリューム）は必須
- 2個目以降は「異なる専門業態で検索結果が実際に変わる」場合のみ追加
  - 追加OK例: 歯科+矯正歯科（異なる医院が上位に出る）
  - 追加NG例: 美容室+ヘアサロン+美容院（ほぼ同一店舗）
- 類語・同義語は絶対に追加しない

JSON形式のみ返す（要素数1〜3）：
{"keywords": ["kw1"]}`,
        },
      ],
      max_tokens: 150,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })

    let keywords: string[] = []
    try {
      const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}')
      if (Array.isArray(parsed.keywords)) {
        keywords = parsed.keywords.filter((k: unknown) => typeof k === 'string' && k.trim()).slice(0, 3)
      }
    } catch {
      keywords = [industry]
    }

    if (keywords.length === 0) keywords = [industry]

    cache.set(industry, keywords)
    return NextResponse.json({ success: true, keywords })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
