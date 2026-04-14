import OpenAI from 'openai'
import logger from '../utils/logger.js'

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini'

/**
 * L-04: フォーム種別判定
 * GPTを使ってフォームが「問い合わせ」か「予約」かを自動判別し、
 * 予約フォームは除外する。
 *
 * @typedef {'inquiry' | 'booking' | 'unknown'} FormType
 */

/**
 * フォームページのHTMLを解析してフォーム種別を判定
 * @param {Object} params
 * @param {string} params.url - フォームページのURL
 * @param {string} params.html - フォームページのHTML（最大5000文字）
 * @param {string} params.title - フォームページのタイトル
 * @param {string} params.linkText - フォームへのリンクテキスト
 * @returns {Promise<{type: FormType, reason: string, confidence: number}>}
 */
export async function classifyForm({ url, html, title, linkText = '' }) {
  // APIキー未設定時はルールベースで判定
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY 未設定 - ルールベース判定にフォールバック')
    return classifyByRules({ url, title, linkText })
  }

  const cleanedHtml = extractTextFromHtml(html)
  const prompt = buildClassificationPrompt({ url, text: cleanedHtml, title, linkText })

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `あなたはWebフォームの種別を判定する専門家です。
与えられたフォームページの情報から、そのフォームが「問い合わせフォーム」か「予約フォーム」かを判定してください。

判定基準:
- 問い合わせフォーム（inquiry）: 一般的な質問・相談・資料請求・見積もり依頼などを受け付けるフォーム
- 予約フォーム（booking）: 来店・施術・サービス利用の日時予約を受け付けるフォーム（カレンダー選択・時間帯選択を含むもの）
- 不明（unknown）: 判定できない場合

必ずJSON形式で返答してください。`
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
      max_tokens: 200
    })

    const result = JSON.parse(response.choices[0].message.content)
    return {
      type: validateFormType(result.type),
      reason: result.reason || '',
      confidence: result.confidence || 0.8
    }
  } catch (error) {
    logger.error('GPTフォーム判定エラー', { error: error.message, url })
    // エラー時はルールベースにフォールバック
    return classifyByRules({ url, title, linkText })
  }
}

/**
 * 複数フォームをバッチ処理（レート制限考慮）
 * @param {Array} forms
 * @returns {Promise<Array>}
 */
export async function classifyFormsBatch(forms) {
  const results = []

  for (const form of forms) {
    const result = await classifyForm(form)
    results.push({ ...form, classification: result })

    // gpt-4o-miniのTPM制限対策：500ms間隔
    await new Promise((r) => setTimeout(r, 500))
  }

  return results
}

// ===== Private helpers =====

function buildClassificationPrompt({ url, text, title, linkText }) {
  return `フォームページの情報:

URL: ${url}
ページタイトル: ${title}
リンクテキスト: ${linkText}
ページテキスト（抜粋）:
${text.slice(0, 1500)}

このフォームの種別を判定してください。

以下のJSONで返答してください:
{
  "type": "inquiry" | "booking" | "unknown",
  "reason": "判定理由を1文で",
  "confidence": 0.0〜1.0の数値
}`
}

/**
 * ルールベースでフォーム種別を判定（GPT不使用時のフォールバック）
 */
function classifyByRules({ url, title, linkText }) {
  const text = `${url} ${title} ${linkText}`.toLowerCase()

  const bookingKeywords = [
    '予約', 'reservation', 'booking', 'ご予約', 'ネット予約',
    'calendar', 'カレンダー', '来店予約', '施術予約', '日時'
  ]

  const inquiryKeywords = [
    'お問い合わせ', 'contact', '問い合わせ', '相談', 'inquiry',
    'ご質問', '資料請求', '見積もり', '申し込み'
  ]

  const bookingScore = bookingKeywords.filter((kw) => text.includes(kw)).length
  const inquiryScore = inquiryKeywords.filter((kw) => text.includes(kw)).length

  if (bookingScore > inquiryScore) {
    return { type: 'booking', reason: 'ルールベース: 予約キーワード検出', confidence: 0.7 }
  } else if (inquiryScore > 0) {
    return { type: 'inquiry', reason: 'ルールベース: 問い合わせキーワード検出', confidence: 0.7 }
  }

  return { type: 'unknown', reason: 'ルールベース: キーワード不一致', confidence: 0.3 }
}

/**
 * HTMLからテキストを抽出（フォーム要素中心）
 */
function extractTextFromHtml(html) {
  // タグを除去してテキストを抽出（cheerio不使用でシンプルに）
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function validateFormType(type) {
  if (['inquiry', 'booking', 'unknown'].includes(type)) return type
  return 'unknown'
}
