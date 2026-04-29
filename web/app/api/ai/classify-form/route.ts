import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'

const Schema = z.object({
  html:    z.string().min(1),
  formUrl: z.string().optional(),
  model:   z.string().optional(),
})

type FormClassification = {
  type: 'inquiry' | 'booking' | 'unknown'
  reason: string
}

export async function POST(req: NextRequest) {
  try {
    const { html, formUrl, model: modelId } = Schema.parse(await req.json())
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ success: false, error: 'OPENAI_API_KEY not configured' }, { status: 500 })
    }

    const client = new OpenAI({ apiKey })
    const truncatedHtml = html.slice(0, 3000)

    const completion = await client.chat.completions.create({
      model: modelId ?? 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `あなたはWebフォームの種別を判定する専門家です。
フォームページの情報から「問い合わせフォーム」か「予約フォーム」かを判定してください。

問い合わせフォーム（inquiry）: 質問・相談・見積もり依頼を受け付けるフォーム
予約フォーム（booking）: 来店・施術の日時予約フォーム（カレンダー選択を含む）
不明（unknown）: 判定できない

必ずJSONで回答してください: {"type":"inquiry"|"booking"|"unknown","reason":"判定理由"}`,
        },
        {
          role: 'user',
          content: `URL: ${formUrl ?? '不明'}\n\nHTML:\n${truncatedHtml}`,
        },
      ],
      temperature: 0,
      max_tokens: 150,
    })

    const raw = completion.choices[0]?.message?.content ?? ''
    let result: FormClassification = { type: 'unknown', reason: '' }
    try {
      const jsonMatch = raw.match(/\{[^}]+\}/)
      if (jsonMatch) result = JSON.parse(jsonMatch[0]) as FormClassification
    } catch { /* keep unknown */ }

    return NextResponse.json({
      success: true,
      type: result.type,
      reason: result.reason,
      tokensInput: completion.usage?.prompt_tokens ?? 0,
      tokensOutput: completion.usage?.completion_tokens ?? 0,
      model: completion.model,
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
