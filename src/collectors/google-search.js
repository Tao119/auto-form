import axios from 'axios'
import logger from '../utils/logger.js'
import { sleep } from '../utils/http-client.js'

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY
const REQUEST_DELAY = parseInt(process.env.REQUEST_DELAY_MS || '2000')

/**
 * Google Places API (New) によるローカルビジネス検索
 * 新エンドポイント: https://places.googleapis.com/v1/places:searchText
 */
export async function searchByPlaces(params) {
  const { industry, area, keywords, maxResults = 50 } = params

  if (!GOOGLE_MAPS_API_KEY) return []

  const all = []
  const seenIds = new Set()

  for (const keyword of keywords) {
    if (all.length >= maxResults) break

    const query = `${keyword} ${area}`.trim()
    logger.info(`Places検索: "${query}"`)

    try {
      const places = await textSearchNew(query)

      for (const place of places) {
        if (all.length >= maxResults) break
        const id = place.id || place.name
        if (seenIds.has(id)) continue
        seenIds.add(id)

        const website = place.websiteUri || ''
        if (!website) {
          logger.debug(`HP URLなし、スキップ: ${place.displayName?.text}`)
          continue
        }
        // 予約サイト・アグリゲーターは除外（自社サイトのみ対象）
        if (isAggregatorUrl(website)) {
          logger.debug(`アグリゲーターURLスキップ: ${website}`)
          continue
        }

        all.push({
          name: place.displayName?.text || '',
          url: website,
          phone: place.nationalPhoneNumber || place.internationalPhoneNumber || '',
          address: place.formattedAddress || '',
          industry,
          area,
          keyword,
          source: 'places'
        })
      }
    } catch (error) {
      logger.error(`Places検索エラー: "${query}"`, { error: error.message })
    }

    await sleep(REQUEST_DELAY)
  }

  logger.info(`Places完了: ${all.length}件`, { industry, area })
  return all
}

const AGGREGATOR_DOMAINS = [
  'hotpepper.jp', 'beauty.hotpepper.jp', 'minimo.io', 'rakuten.co.jp',
  'tabelog.com', 'jalan.net', 'booking.com', 'airbnb.com', 'tripadvisor',
  'indeed.com', 'recruit.co.jp', 'townwork.net', 'baito.com',
  'instagram.com', 'facebook.com', 'twitter.com', 'x.com', 'youtube.com',
  'ameblo.jp', 'cookpad.com', 'gurunavi.com', 'eparkbeauty.com'
]

function isAggregatorUrl(url) {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return AGGREGATOR_DOMAINS.some(d => host.includes(d))
  } catch {
    return false
  }
}

/**
 * Places API (New) - Text Search
 * https://developers.google.com/maps/documentation/places/web-service/text-search
 */
async function textSearchNew(query, maxResults = 20) {
  const results = []
  let pageToken = null

  while (results.length < maxResults) {
    const body = {
      textQuery: query,
      languageCode: 'ja',
      regionCode: 'JP',
      maxResultCount: Math.min(20, maxResults - results.length)
    }
    if (pageToken) body.pageToken = pageToken

    const res = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      body,
      {
        headers: {
          'X-Goog-Api-Key': GOOGLE_MAPS_API_KEY,
          'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.websiteUri,places.nationalPhoneNumber,places.internationalPhoneNumber,nextPageToken'
        },
        timeout: 10000
      }
    )

    const data = res.data
    results.push(...(data.places || []))
    pageToken = data.nextPageToken || null
    if (!pageToken || results.length >= maxResults) break
    await sleep(1000)
  }

  return results
}
