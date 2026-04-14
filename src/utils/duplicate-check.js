import logger from './logger.js'

/**
 * L-05: 重複チェック
 * スプシ既存データと照合し、重複企業を自動スキップ・フラグ管理
 */

/**
 * 新規収集リストから重複を除外する
 * @param {Array<{url: string, name: string}>} newCompanies - 新規収集データ
 * @param {Set<string>} existingUrls - 既存データのURL（正規化済み）
 * @returns {{unique: Array, duplicates: Array, stats: Object}}
 */
export function filterDuplicates(newCompanies, existingUrls) {
  const unique = []
  const duplicates = []

  for (const company of newCompanies) {
    const normalizedUrl = normalizeUrl(company.url)
    const isDuplicate = normalizedUrl && existingUrls.has(normalizedUrl)

    if (isDuplicate) {
      duplicates.push({ ...company, duplicateFlag: true })
      logger.debug(`重複スキップ: ${company.name} (${company.url})`)
    } else {
      unique.push(company)
      // 新規追加したURLをセットに追加（同一バッチ内での重複も防ぐ）
      if (normalizedUrl) existingUrls.add(normalizedUrl)
    }
  }

  const stats = {
    total: newCompanies.length,
    unique: unique.length,
    duplicates: duplicates.length,
    deduplicationRate: newCompanies.length > 0
      ? Math.round((duplicates.length / newCompanies.length) * 100)
      : 0
  }

  logger.info('重複チェック完了', stats)
  return { unique, duplicates, stats }
}

/**
 * 単一企業の重複確認
 * @param {string} url
 * @param {Set<string>} existingUrls
 * @returns {boolean}
 */
export function isDuplicate(url, existingUrls) {
  const normalized = normalizeUrl(url)
  return normalized ? existingUrls.has(normalized) : false
}

/**
 * URLを正規化（ホスト名ベースで比較）
 * 例: https://example.com/about → example.com
 */
function normalizeUrl(url) {
  if (!url) return null
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return url.toLowerCase().trim()
  }
}
