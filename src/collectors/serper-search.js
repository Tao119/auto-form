import axios from 'axios'
import logger from '../utils/logger.js'
import { sleep } from '../utils/http-client.js'

const SERPER_API_KEY = process.env.SERPER_API_KEY
const REQUEST_DELAY = parseInt(process.env.REQUEST_DELAY_MS || '2000')

/**
 * Serper.dev APIを使ったGoogle検索
 * 全業界対応：Google検索結果をそのまま取得できる
 * 料金: $50/月 で50,000クエリ（約0.1円/件）
 * https://serper.dev
 */

/**
 * キーワード + エリアで企業を検索
 * @param {Object} params
 * @returns {Promise<Array<{name, url, snippet}>>}
 */
export async function searchBySerper(params) {
  const { industry, area, keywords, excludeKeywords = [], maxResults = 50 } = params

  if (!SERPER_API_KEY) {
    throw new Error('SERPER_API_KEY が設定されていません。https://serper.dev でAPIキーを取得してください')
  }

  const results = []
  const seenUrls = new Set()

  for (const keyword of keywords) {
    if (results.length >= maxResults) break

    // クエリ: "美容室 東京都 お問い合わせ -予約 -ホットペッパー"
    const query = buildQuery({ keyword, area, excludeKeywords })
    logger.info(`Serper検索: "${query}"`)

    try {
      const items = await fetchSerperResults(query, Math.min(10, maxResults - results.length))

      for (const item of items) {
        const url = item.link
        if (!url) continue
        const host = normalizeHost(url)
        if (seenUrls.has(host)) continue
        seenUrls.add(host)

        results.push({
          name: cleanTitle(item.title),
          url,
          snippet: item.snippet || '',
          industry,
          area,
          keyword,
          source: 'serper'
        })
      }
    } catch (error) {
      logger.error(`Serper検索エラー: "${query}"`, { error: error.message })
    }

    await sleep(REQUEST_DELAY)
  }

  logger.info(`Serper検索完了: ${results.length}件`, { industry, area })
  return results
}

// ===== Private =====

async function fetchSerperResults(query, num = 10) {
  const response = await axios.post(
    'https://google.serper.dev/search',
    {
      q: query,
      gl: 'jp',
      hl: 'ja',
      num: Math.min(num, 10) // Serperは1回最大10件
    },
    {
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    }
  )

  return response.data.organic || []
}

function buildQuery({ keyword, area, excludeKeywords }) {
  let q = `${keyword} ${area} お問い合わせ`.trim()
  // 除外: 予約サイト・求人を自動除外
  const defaultExcludes = ['ホットペッパー', 'じゃらん', '求人', '採用', 'indeed', '楽天ビューティー']
  const allExcludes = [...new Set([...defaultExcludes, ...excludeKeywords])]
  for (const ex of allExcludes) q += ` -${ex}`
  return q
}

function cleanTitle(title) {
  return title
    .replace(/\s*[|｜]\s*.+$/, '')
    .replace(/\s*[-–—]\s*.+$/, '')
    .replace(/【[^】]*】/g, '')
    .trim()
}

function normalizeHost(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return url.toLowerCase()
  }
}
