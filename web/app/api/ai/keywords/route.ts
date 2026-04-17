import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'

const Schema = z.object({ industry: z.string().min(1).max(100) })

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
          content: `業種「${industry}」をGoogleマップで全国検索する際、漏れを最小化するための検索キーワードを最大8つ提案してください。

要件：
- Googleマップの検索ボックスに直接入力する短い日本語キーワード（1〜4語）
- 同業態でも異なる呼称・業態名・店舗タイプをカバーする（チェーン・個人・専門店など）
- 類似しすぎるものは省く（例: 「美容室」と「ビューティーサロン」は重複）
- 検索ヒット数が多い順に並べる

以下のJSON形式のみ返す：
{"keywords": ["kw1", "kw2", "kw3"]}`,
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
        keywords = parsed.keywords.filter((k: unknown) => typeof k === 'string' && k.trim()).slice(0, 8)
      }
    } catch {
      keywords = [industry]
    }

    if (keywords.length === 0) keywords = [industry]

    return NextResponse.json({ success: true, keywords })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
