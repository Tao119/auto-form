import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import OpenAI from 'openai'

const Schema = z.object({
  industry: z.string().min(1).max(100),
  area: z.string().min(1).max(100).optional(),
})

const cache = new Map<string, { keywords: string[]; suffixes: string[] }>()

let _openai: OpenAI | null = null
function getOpenAI() {
  if (!_openai && process.env.OPENAI_API_KEY) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openai
}

// suffixes always applied — pulls official/contact pages to top of results
const DEFAULT_SUFFIXES = ['お問い合わせ', '公式サイト', 'contact']

// Known synonym groups — if the generated keywords contain synonyms, deduplicate them
// Key = canonical term, Value = list of synonyms to reject
const SYNONYM_GROUPS: Record<string, string[]> = {
  '美容室': ['ヘアサロン', '美容院', 'hair salon', 'ビューティーサロン'],
  '整骨院': ['接骨院', '柔道整復師'],
  '歯科':   ['歯医者', 'デンタルクリニック', 'dental clinic'],
  '中古車': ['中古自動車', '中古車販売店', '中古車販売', '中古車ショップ', '中古車センター', '中古車ディーラー', 'used car'],
  '学習塾': ['塾', '個別指導塾', '予備校'],
}

function deduplicateSynonyms(keywords: string[]): string[] {
  if (keywords.length <= 1) return keywords
  const result: string[] = []
  const rejected = new Set<string>()
  for (const kw of keywords) {
    if (rejected.has(kw)) continue
    result.push(kw)
    // Mark synonyms of this keyword as rejected
    for (const [canonical, synonyms] of Object.entries(SYNONYM_GROUPS)) {
      if (kw === canonical || kw.includes(canonical) || canonical.includes(kw)) {
        synonyms.forEach((s) => rejected.add(s))
      }
      if (synonyms.includes(kw)) {
        // This keyword IS a synonym — remove previously added synonyms too
        synonyms.forEach((s) => {
          if (s !== kw && result.includes(s)) {
            const idx = result.indexOf(s)
            if (idx !== -1) result.splice(idx, 1)
          }
          rejected.add(s)
        })
      }
    }
  }
  return result
}

// Population-based density tiers for area classification
// 大都市区: 区単位 → 高密度
// 政令市区・東京市部: 中〜高密度
// 地方都市: 低〜中密度
const HIGH_DENSITY_AREAS = [
  // 東京23区
  '千代田区','中央区','港区','新宿区','文京区','台東区','墨田区','江東区',
  '品川区','目黒区','大田区','世田谷区','渋谷区','中野区','杉並区','豊島区',
  '北区','荒川区','板橋区','練馬区','足立区','葛飾区','江戸川区',
  // 大阪市区
  '大阪市北区','大阪市中央区','大阪市西区','大阪市浪速区','大阪市天王寺区',
  '大阪市淀川区','大阪市東淀川区',
  // 名古屋市区
  '名古屋市中区','名古屋市東区','名古屋市中村区','名古屋市西区',
  // 横浜・川崎主要区
  '横浜市西区','横浜市中区','横浜市港北区','川崎市中原区',
  // 政令市・大都市（市単位）
  '名古屋市','大阪市','福岡市','京都市','神戸市','仙台市','広島市','北九州市',
  // 東京市部（人口多め）
  '八王子市','町田市','府中市','調布市','武蔵野市',
]

const MEDIUM_DENSITY_AREAS = [
  // 政令市（区でなく市全体）
  '横浜市','川崎市','さいたま市','千葉市','相模原市','浜松市','静岡市',
  '岡山市','熊本市','札幌市',
  // 中核市・特例市
  '船橋市','宇都宮市','松山市','金沢市','高松市','熊谷市','豊橋市',
  '岐阜市','富山市','長野市','和歌山市','高知市','大分市','宮崎市',
  '鹿児島市','長崎市','那覇市','秋田市','山形市','福島市','水戸市',
  '甲府市','奈良市','大津市','鳥取市','松江市','山口市','徳島市',
  // 東京市部・神奈川
  '立川市','相模原市','厚木市','藤沢市','川越市','所沢市','越谷市',
]

function getAreaDensityTier(area: string): 'high' | 'medium' | 'low' {
  if (HIGH_DENSITY_AREAS.includes(area)) return 'high'
  if (MEDIUM_DENSITY_AREAS.includes(area)) return 'medium'
  // 都道府県名は高密度（複数区に分割して実行される想定）
  if (area.endsWith('都') || area.endsWith('道') || area.endsWith('府') || area.endsWith('県')) return 'high'
  return 'low'
}

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

    const densityTier = getAreaDensityTier(area ?? '')
    const maxKeywords = densityTier === 'high' ? 4 : densityTier === 'medium' ? 2 : 1

    const resp = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'あなたはGoogle検索キーワード設計のエキスパートです。JSONのみ返してください。',
        },
        {
          role: 'user',
          content: `業種「${industry}」のGoogle検索キーワードを最大${maxKeywords}個設計してください。

【ルール】
1. 「${industry}」と同業種・同種施設の別呼称のみ追加する（全く別業種は絶対NG）
2. 同一店舗が両方に出る同義語は追加しない（例: 美容室 + ヘアサロン はNG）
3. 業種名のみ記載（エリア名を含めない）
4. 必ず「${industry}」を最初のキーワードに含める

【例】
- 歯科医院(最大4個): ["歯科", "矯正歯科", "小児歯科", "インプラント"]
- 整骨院(最大1個): ["整骨院"]
- 美容室(最大4個): ["美容室", "縮毛矯正専門", "カット専門店", "ヘアカラー専門"]

JSON（コメント不要）：{"keywords": ["..."]}"`,
        },
      ],
      max_tokens: 100,
      temperature: 0.1,
      response_format: { type: 'json_object' },
    })

    let keywords: string[] = [industry]

    try {
      const parsed = JSON.parse(resp.choices[0]?.message?.content ?? '{}')
      if (Array.isArray(parsed.keywords) && parsed.keywords.length > 0) {
        // Ensure industry itself is first, deduplicate
        const kws = parsed.keywords
          .filter((k: unknown) => typeof k === 'string' && k.trim())
          .slice(0, maxKeywords)
        // Industry must be present (use original form)
        if (!kws.some((k: string) => k.includes(industry) || industry.includes(k))) {
          kws.unshift(industry)
        }
        keywords = deduplicateSynonyms(kws).slice(0, maxKeywords)
      }
    } catch {
      keywords = [industry]
    }

    if (keywords.length === 0) keywords = [industry]

    const result = { keywords, suffixes: DEFAULT_SUFFIXES }
    cache.set(cacheKey, result)
    return NextResponse.json({ success: true, ...result })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
