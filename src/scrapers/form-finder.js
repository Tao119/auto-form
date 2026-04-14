import * as cheerio from 'cheerio'
import { fetchPage, resolveUrl, sleep } from '../utils/http-client.js'
import logger from '../utils/logger.js'
import searchParams from '../../config/search-params.json' with { type: 'json' }

const { contactPageKeywords, bookingPageKeywords, formSelectors } = searchParams.formDetection
const REQUEST_DELAY = parseInt(process.env.REQUEST_DELAY_MS || '2000')

/**
 * L-03: HP・フォームURL確認
 * 企業HPにアクセスし、お問い合わせフォームを自動探索
 *
 * @param {string} baseUrl - 企業HPのURL
 * @returns {Promise<FormScanResult>}
 *
 * @typedef {Object} FormScanResult
 * @property {string} baseUrl - 企業HP URL
 * @property {string|null} formUrl - フォームページのURL
 * @property {string|null} email - メールアドレス
 * @property {string|null} phone - 電話番号
 * @property {boolean} hasForm - フォームが存在するか
 * @property {string} formPageHtml - フォームページのHTML（AI分類用）
 * @property {string} formPageTitle - フォームページのタイトル
 */
export async function findContactForm(baseUrl) {
  logger.debug(`フォーム探索開始: ${baseUrl}`)

  try {
    // Step 1: トップページを取得
    const topPageResponse = await fetchPage(baseUrl)
    if (!topPageResponse || topPageResponse.status >= 400) {
      return createEmptyResult(baseUrl, 'トップページ取得失敗')
    }

    const $ = cheerio.load(topPageResponse.data)
    const topHtml = topPageResponse.data

    // Step 2: トップページから電話・メールを抽出
    const phone = extractPhone(topHtml)
    const email = extractEmail(topHtml)

    // Step 3: お問い合わせページへのリンクを探す
    const contactLinks = findContactLinks($, baseUrl)

    if (contactLinks.length === 0) {
      // Step 3b: トップページ自体にフォームがあるか確認
      if (hasFormElements($)) {
        return {
          baseUrl,
          formUrl: baseUrl,
          email,
          phone,
          hasForm: true,
          formPageHtml: topHtml.slice(0, 5000),
          formPageTitle: $('title').text().trim(),
          status: 'found_on_top'
        }
      }
      return createEmptyResult(baseUrl, 'お問い合わせリンク未検出')
    }

    // Step 4: 優先度の高いリンクからフォームページを取得
    for (const link of contactLinks.slice(0, 3)) {
      await sleep(500)

      try {
        const formPageResponse = await fetchPage(link.url)
        if (!formPageResponse || formPageResponse.status >= 400) continue

        const $form = cheerio.load(formPageResponse.data)
        const formHtml = formPageResponse.data

        if (hasFormElements($form)) {
          return {
            baseUrl,
            formUrl: link.url,
            email: email || extractEmail(formHtml),
            phone: phone || extractPhone(formHtml),
            hasForm: true,
            formPageHtml: formHtml.slice(0, 5000),
            formPageTitle: $form('title').text().trim(),
            linkText: link.text,
            status: 'found'
          }
        }
      } catch (err) {
        logger.debug(`フォームページ取得失敗: ${link.url}`, { error: err.message })
      }
    }

    return createEmptyResult(baseUrl, 'フォーム要素未検出')
  } catch (error) {
    logger.error(`フォーム探索エラー: ${baseUrl}`, { error: error.message })
    return createEmptyResult(baseUrl, error.message)
  }
}

// ===== Private helpers =====

/**
 * ページからお問い合わせ関連リンクを抽出（優先度付き）
 */
function findContactLinks($, baseUrl) {
  const links = []
  const seen = new Set()

  $('a[href]').each((_, el) => {
    const href = $(el).attr('href')
    const text = $(el).text().trim()

    if (!href) return

    const absoluteUrl = resolveUrl(baseUrl, href)
    if (!absoluteUrl || !absoluteUrl.startsWith('http')) return

    // 外部ドメインは除外
    try {
      const base = new URL(baseUrl)
      const link = new URL(absoluteUrl)
      if (base.hostname !== link.hostname) return
    } catch {
      return
    }

    if (seen.has(absoluteUrl)) return
    seen.add(absoluteUrl)

    const lowerText = text.toLowerCase()
    const lowerHref = absoluteUrl.toLowerCase()

    // 予約ページを除外
    const isBooking = bookingPageKeywords.some(
      (kw) => lowerText.includes(kw.toLowerCase()) || lowerHref.includes(kw.toLowerCase())
    )
    if (isBooking) return

    // お問い合わせリンクのスコアリング
    const score = scoreContactLink(text, absoluteUrl)
    if (score > 0) {
      links.push({ url: absoluteUrl, text, score })
    }
  })

  // スコアの高い順にソート
  return links.sort((a, b) => b.score - a.score)
}

function scoreContactLink(text, url) {
  let score = 0
  const lowerText = text.toLowerCase()
  const lowerUrl = url.toLowerCase()

  for (const kw of contactPageKeywords) {
    const lowerKw = kw.toLowerCase()
    if (lowerText.includes(lowerKw)) score += 10
    if (lowerUrl.includes(lowerKw)) score += 5
  }

  // URLパターンによる加点
  if (/contact|inquiry|form|mail|message/i.test(url)) score += 8
  if (/toiawase|otoiawase/i.test(url)) score += 8

  return score
}

/**
 * ページにフォーム要素が存在するか確認
 */
function hasFormElements($) {
  for (const selector of formSelectors) {
    if ($(selector).length > 0) return true
  }
  return false
}

/**
 * HTMLから電話番号を抽出
 */
function extractPhone(html) {
  const patterns = [
    /tel:([0-9\-+\s()]{10,15})/i,
    /(\d{2,4}[-\s]?\d{2,4}[-\s]?\d{3,4})/
  ]

  for (const pattern of patterns) {
    const match = html.match(pattern)
    if (match) {
      const phone = match[1].replace(/\s/g, '').trim()
      if (phone.replace(/[-+()]/g, '').length >= 10) {
        return phone
      }
    }
  }
  return null
}

/**
 * HTMLからメールアドレスを抽出
 */
function extractEmail(html) {
  // mailto: リンク優先
  const mailtoMatch = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
  if (mailtoMatch) return mailtoMatch[1]

  // テキスト内のメールアドレス
  const emailMatch = html.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
  if (emailMatch) {
    // 一般的でないアドレスを除外（noreply等）
    const email = emailMatch[1]
    if (!/noreply|no-reply|example|test/i.test(email)) {
      return email
    }
  }

  return null
}

function createEmptyResult(baseUrl, reason) {
  return {
    baseUrl,
    formUrl: null,
    email: null,
    phone: null,
    hasForm: false,
    formPageHtml: '',
    formPageTitle: '',
    status: 'not_found',
    reason
  }
}
