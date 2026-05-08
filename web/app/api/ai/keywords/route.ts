import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'

const Schema = z.object({
  industry: z.string().min(1).max(100),
  area: z.string().min(1).max(100).optional(),
})

// cache key = "industry::area"
const cache = new Map<string, { keywords: string[]; suffixes: string[] }>()

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openai
}

/**
 * POST /api/ai/keywords
 * 業種+エリアから検索キーワードと修飾語を生成する。
 * 業種×エリアの密度が高く100件を超えそうと判断した場合のみ
 * キーワード数を増やし、修飾語バリエーションも返す。
 * 通常は keywords: [1〜2個], suffixes: [] を返す。
 */
export async function POST(req: NextRequest) {
  try {
    const { industry, area } = Schema.parse(await req.json())

    const cacheKey = `${industry}::${area ?? ''}`
    const cached = cache.get(cacheKey)
    if (cached) return NextResponse.json({ success: true, ...cached })

    const openai = getOpenAI()
    if (!openai) {
      return NextResponse.json({ success: false, error: 'OpenAI API key not configured' }, { status: 500 })
    }

    const areaContext = area ? `エリア「${area}」` : '都市部（エリア未指定）'

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'あなたはGoogleマップで日本の店舗・施設を網羅的に検索するためのキーワード設計のエキスパートです。JSONのみ返してください。',
        },
        {
          role: 'user',
          content: `業種「${industry}」を${areaContext}でGoogleマップ検索するとき、何件の店舗が存在するか推定し、最適な検索戦略を決定してください。

【判断ロジック】
1. まず${areaContext}での「${industry}」の店舗密度を推定する（少: <50件, 中: 50〜100件, 多: >100件）
2. 密度が「多」の場合のみクエリを多様化する。「少」「中」は最小限のキーワードのみ

【密度が「多」の場合のクエリ多様化ルール】
- キーワード: 異なる専門業態・呼称で検索結果が変わるものを最大3個（同義語は禁止）
- 修飾語(suffixes): 公式サイトや問い合わせページを引き出す語を最大3個
  例: ["お問い合わせ", "公式サイト", "予約"]
- キーワード×修飾語の組み合わせで網羅的にカバーする

【密度が「少」「中」の場合】
- キーワード: メインキーワード1個のみ
- 修飾語: [] （空配列）

JSON形式のみ返す：
{
  "estimatedCount": 推定件数(整数),
  "density": "少" | "中" | "多",
  "keywords": ["kw1"],
  "suffixes": []
}`,
        },
      ],
      max_tokens: 200,
      temperature: 0.2,
      response_format: { type: 'json_object' },
    })

    let keywords: string[] = [industry]
    let suffixes: string[] = []

    try {
      const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}')
      if (Array.isArray(parsed.keywords) && parsed.keywords.length > 0) {
        keywords = parsed.keywords.filter((k: unknown) => typeof k === 'string' && k.trim()).slice(0, 3)
      }
      if (Array.isArray(parsed.suffixes)) {
        suffixes = parsed.suffixes.filter((s: unknown) => typeof s === 'string' && s.trim()).slice(0, 3)
      }
    } catch {
      keywords = [industry]
      suffixes = []
    }

    if (keywords.length === 0) keywords = [industry]

    const result = { keywords, suffixes }
    cache.set(cacheKey, result)
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
