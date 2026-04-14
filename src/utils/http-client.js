import axios from 'axios'
import pRetry from 'p-retry'
import UserAgent from 'user-agents'
import logger from './logger.js'

const DEFAULT_TIMEOUT = parseInt(process.env.HTTP_TIMEOUT_MS || '10000')
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3')

/**
 * レート制限対応HTTPクライアント
 * - ランダムなUser-Agent
 * - 自動リトライ (429, 5xx)
 * - タイムアウト設定
 */
export async function fetchPage(url, options = {}) {
  const userAgent = new UserAgent({ deviceCategory: 'desktop' })

  const run = async () => {
    const response = await axios.get(url, {
      timeout: options.timeout || DEFAULT_TIMEOUT,
      headers: {
        'User-Agent': userAgent.toString(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en-US;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        'Connection': 'keep-alive',
        ...options.headers
      },
      maxRedirects: 5,
      validateStatus: (status) => status < 500
    })

    if (response.status === 429) {
      throw new pRetry.AbortError(`Rate limited: ${url}`)
    }

    return response
  }

  try {
    return await pRetry(run, {
      retries: MAX_RETRIES,
      minTimeout: 1000,
      maxTimeout: 5000,
      onFailedAttempt: (error) => {
        logger.warn(`リトライ中 (${error.attemptNumber}/${MAX_RETRIES + 1}): ${url}`, {
          error: error.message
        })
      }
    })
  } catch (error) {
    logger.error(`フェッチ失敗: ${url}`, { error: error.message })
    throw error
  }
}

/**
 * 指定ミリ秒待機
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * URLを正規化（末尾スラッシュ除去、小文字化）
 */
export function normalizeUrl(url) {
  try {
    const parsed = new URL(url)
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`.replace(/\/$/, '')
  } catch {
    return url
  }
}

/**
 * 相対URLを絶対URLに変換
 */
export function resolveUrl(base, href) {
  try {
    return new URL(href, base).toString()
  } catch {
    return null
  }
}
