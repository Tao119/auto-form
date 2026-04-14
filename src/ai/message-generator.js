import OpenAI from 'openai'
import logger from '../utils/logger.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

/**
 * F-05/06: 業種別営業文章生成
 * 500字版（フォームの文字制限対応）と3000字版の2パターンを生成
 */

// ===== 業種別プロンプト定義 =====
const INDUSTRY_PROMPTS = {
  'ヘッドスパ': {
    service: 'AIを活用した集客・マーケティング支援',
    pain: '新規顧客獲得・リピート率向上・SNS運用の効率化',
    appeal: 'ドライヘッドスパ・ヘッドスパ専門サロン様の集客実績あり'
  },
  '美容クリニック': {
    service: 'AIを活用したWeb集客・コンテンツマーケティング支援',
    pain: '問い合わせ数増加・予約率向上・競合差別化',
    appeal: '美容医療・美容皮膚科様の集客実績あり'
  },
  'リスキリング': {
    service: 'AI活用した受講生獲得・コンテンツ最適化支援',
    pain: '受講申込み増加・ターゲティング精度向上・LTV改善',
    appeal: 'スキルアップ・リスキリングスクール様の支援実績あり'
  },
  '中古車': {
    service: 'AIを活用した在庫訴求・問い合わせ最適化支援',
    pain: '展示車両への問い合わせ増加・成約率向上',
    appeal: '中古車販売店様のデジタルマーケティング支援実績あり'
  },
  'YouTube': {
    service: 'YouTube×AI活用のマーケティング戦略支援',
    pain: '動画経由のリード獲得・チャンネル活用の収益化',
    appeal: 'YouTubeマーケティング実施企業様の支援実績あり'
  },
  'default': {
    service: 'AIを活用した集客・業務効率化支援',
    pain: '新規顧客獲得・業務効率化・売上向上',
    appeal: '様々な業種での実績あり'
  }
}

/**
 * 企業情報から業種プロンプトを選択
 */
function selectPromptConfig(industry, companyInfo = '') {
  const text = `${industry} ${companyInfo}`.toLowerCase()

  if (/ヘッドスパ|ドライヘッド/.test(text)) return INDUSTRY_PROMPTS['ヘッドスパ']
  if (/美容クリニック|美容整形|美容皮膚科|クリニック/.test(text)) return INDUSTRY_PROMPTS['美容クリニック']
  if (/スクール|プログラミング|動画編集|webデザイン|リスキリング/.test(text)) return INDUSTRY_PROMPTS['リスキリング']
  if (/中古車|自動車販売|カーディーラー/.test(text)) return INDUSTRY_PROMPTS['中古車']
  if (/youtube|ユーチューブ|動画マーケ/.test(text)) return INDUSTRY_PROMPTS['YouTube']

  return INDUSTRY_PROMPTS['default']
}

/**
 * 営業文章を生成（500字 + 3000字の2パターン）
 *
 * @param {Object} params
 * @param {string} params.companyName - 会社名
 * @param {string} params.industry - 業種
 * @param {string} params.companyInfo - 企業HPから取得した情報（サービス説明等）
 * @returns {Promise<{short: string, long: string}>}
 */
export async function generateMessages({ companyName, industry, companyInfo = '' }) {
  const config = selectPromptConfig(industry, companyInfo)

  const [short, long] = await Promise.all([
    generateMessage({ companyName, config, companyInfo, targetLength: 500 }),
    generateMessage({ companyName, config, companyInfo, targetLength: 3000 })
  ])

  return { short, long }
}

async function generateMessage({ companyName, config, companyInfo, targetLength }) {
  const isShort = targetLength <= 500

  const systemPrompt = `あなたは優秀な営業文章ライターです。
企業のお問い合わせフォーム宛に送る営業文章を作成してください。

必須条件:
- 文字数: ${isShort ? '400〜500字' : '2500〜3000字'}
- 書き出しは「はじめまして」または企業名から始める
- 押し売り感を出さず、まず相手の課題に共感する
- 具体的な提供価値を明示する
- 問い合わせを促すCTA（行動喚起）で締める
- 差出人: 株式会社REMEDY`

  const userPrompt = `以下の情報をもとに営業文章を作成してください。

宛先企業: ${companyName}
業種: ${industry}
提供サービス: ${config.service}
解決できる課題: ${config.pain}
訴求ポイント: ${config.appeal}

企業HP情報（参考）:
${companyInfo.slice(0, 500)}

${isShort ? '※ フォームの文字数制限があるため400〜500字以内で簡潔に。' : '※ 詳細な提案内容を含む3000字程度の本格的な営業文章で。'}`

  try {
    const response = await openai.chat.completions.create({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: isShort ? 800 : 5000
    })

    return response.choices[0].message.content.trim()
  } catch (error) {
    logger.error(`文章生成エラー: ${companyName}`, { error: error.message })
    throw error
  }
}

/**
 * 企業HPのテキストを取得してサービス情報を抽出（F-03）
 */
export async function extractCompanyInfo(html) {
  if (!html) return ''

  // HTMLタグを除去してテキスト抽出
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000)

  return text
}
