import 'dotenv/config'
import pLimit from 'p-limit'
import logger from './utils/logger.js'
import { sleep } from './utils/http-client.js'
import { collectCompanies } from './collectors/index.js'
import { findContactForm } from './scrapers/form-finder.js'
import { classifyForm } from './ai/form-classifier.js'
import { initializeSheet, getExistingUrls, appendCompany, getSpreadsheetId } from './sheets/sheets-client.js'
import { filterDuplicates } from './utils/duplicate-check.js'
import searchParams from '../config/search-params.json' with { type: 'json' }

const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '5')
const REQUEST_DELAY = parseInt(process.env.REQUEST_DELAY_MS || '2000')

/**
 * メインオーケストレーション
 * L-01〜L-06 のフルパイプラインを実行する
 */
async function run() {
  logger.info('=== リスト収集AI 開始 ===')
  logger.info(`実行日時: ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`)

  // 有効な実行設定を取得 + 「全国」エリアを自動展開
  const areaMap = searchParams.areaExpansion || {}
  const activeRuns = searchParams.runs
    .filter((r) => r.enabled)
    .map((r) => ({
      ...r,
      searchTargets: r.searchTargets.flatMap((t) => {
        const expanded = areaMap[t.area]
        if (!expanded) return [t]
        return expanded.map((area) => ({ ...t, area }))
      })
    }))

  if (activeRuns.length === 0) {
    logger.warn('有効な実行設定がありません。config/search-params.json の enabled を true にしてください')
    return
  }

  const totalTargets = activeRuns.reduce((s, r) => s + r.searchTargets.length, 0)
  logger.info(`実行ターゲット: ${totalTargets}件（エリア展開後）`)

  // Google Sheets 初期化（未設定なら自動作成、設定済みならヘッダー確認）
  const spreadsheetId = await initializeSheet()
  if (spreadsheetId) {
    logger.info(`スプレッドシートID: ${spreadsheetId}`)
  }

  // 既存データのURL一覧を取得（重複チェック用）
  const existingUrls = spreadsheetId
    ? await getExistingUrls()
    : new Set()

  const allStats = { total: 0, written: 0, skippedDuplicate: 0, skippedBooking: 0, noForm: 0 }

  // 各実行設定を処理
  for (const runConfig of activeRuns) {
    logger.info(`\n--- 実行: ${runConfig.label} ---`)

    for (const target of runConfig.searchTargets) {
      logger.info(`検索開始: ${target.industry} / ${target.area}`)

      // Step 1: 企業リスト収集 (L-02)
      const rawCompanies = await collectCompanies(target)
      logger.info(`収集完了: ${rawCompanies.length}件`)

      // Step 2: 重複除去 (L-05)
      const { unique, stats: dupStats } = filterDuplicates(rawCompanies, existingUrls)
      allStats.skippedDuplicate += dupStats.duplicates

      if (unique.length === 0) {
        logger.info('新規企業なし - スキップ')
        continue
      }

      // Step 3: バッチ処理（HP確認 → フォーム判定 → シート書き込み）
      const limit = pLimit(BATCH_SIZE)

      const tasks = unique.map((company) =>
        limit(async () => {
          allStats.total++

          try {
            // Step 3a: HPフォームURL確認 (L-03)
            const formResult = await findContactForm(company.url)

            if (!formResult.hasForm) {
              allStats.noForm++
              logger.debug(`フォームなし: ${company.name}`)
              return null
            }

            // Step 3b: フォーム種別判定 (L-04)
            const classification = await classifyForm({
              url: formResult.formUrl,
              html: formResult.formPageHtml,
              title: formResult.formPageTitle,
              linkText: formResult.linkText || ''
            })

            if (classification.type === 'booking') {
              allStats.skippedBooking++
              logger.debug(`予約フォームのためスキップ: ${company.name}`)
              return null
            }

            // Step 3c: スプシ書き込み (L-06)
            const companyData = {
              name: company.name,
              url: company.url,
              formUrl: formResult.formUrl,
              phone: formResult.phone || company.phone || '',
              email: formResult.email || '',
              address: company.address || '',
              industry: company.industry,
              area: company.area,
              formType: classification.type,
              status: '未送信'
            }

            if (getSpreadsheetId()) {
              await appendCompany(companyData)
            }

            allStats.written++
            logger.info(`✓ 登録: ${company.name} | ${formResult.formUrl}`)
            return companyData
          } catch (error) {
            logger.error(`処理エラー: ${company.name}`, { error: error.message })
            return null
          }
        })
      )

      const results = await Promise.all(tasks)
      const written = results.filter(Boolean)
      logger.info(`バッチ完了: ${written.length}件書き込み / ${unique.length}件中`)

      await sleep(REQUEST_DELAY)
    }
  }

  // 最終サマリー
  logger.info('\n=== 実行完了 ===')
  logger.info(`処理件数:   ${allStats.total}`)
  logger.info(`書き込み:   ${allStats.written}`)
  logger.info(`重複スキップ: ${allStats.skippedDuplicate}`)
  logger.info(`予約除外:   ${allStats.skippedBooking}`)
  logger.info(`フォームなし: ${allStats.noForm}`)
}

// エントリーポイント
run().catch((error) => {
  logger.error('致命的エラー', { error: error.message, stack: error.stack })
  process.exit(1)
})
