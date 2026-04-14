import logger from '../utils/logger.js'
import { searchBySerper } from './serper-search.js'
import { searchByPlaces } from './google-search.js'

/**
 * 企業収集の統合エントリーポイント
 *
 * 戦略:
 *   1. Serper.dev（Google検索） → 全業界対応・メイン
 *   2. Google Maps Places API  → ローカル系ビジネスの補完（電話・住所を強化）
 *
 * どちらか一方だけでも動作する（APIキー未設定の方はスキップ）
 */
export async function collectCompanies(params) {
  const hasSerper = !!process.env.SERPER_API_KEY
  const hasPlaces = !!process.env.GOOGLE_MAPS_API_KEY

  if (!hasSerper && !hasPlaces) {
    throw new Error('SERPER_API_KEY または GOOGLE_MAPS_API_KEY のいずれかが必要です')
  }

  const [serperResult, placesResult] = await Promise.allSettled([
    hasSerper ? searchBySerper(params) : Promise.resolve([]),
    hasPlaces  ? searchByPlaces(params)  : Promise.resolve([])
  ])

  const serperItems = serperResult.status === 'fulfilled' ? serperResult.value : []
  const placesItems = placesResult.status === 'fulfilled' ? placesResult.value : []

  if (serperResult.status === 'rejected') {
    logger.warn('Serper検索失敗', { error: serperResult.reason?.message })
  }
  if (placesResult.status === 'rejected') {
    logger.warn('Places検索失敗', { error: placesResult.reason?.message })
  }

  // URLホスト名ベースで重複除去（PlacesはSerperを補完する形）
  const seen = new Set()
  const merged = []

  for (const item of [...serperItems, ...placesItems]) {
    const host = normalizeHost(item.url)
    if (!host || seen.has(host)) continue
    seen.add(host)
    merged.push(item)
  }

  logger.info(`収集合計: ${merged.length}件 (Serper: ${serperItems.length}, Places: ${placesItems.length})`)
  return merged
}

function normalizeHost(url) {
  try {
    return new URL(url || '').hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}
