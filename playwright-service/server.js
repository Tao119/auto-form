/**
 * Playwright フォーム送信サービス
 * n8n から HTTP Request ノードで呼び出す
 *
 * POST /submit-form   → フォーム入力・送信・スクショ
 * POST /check-form    → フォーム種別確認（予約 or 問い合わせ）
 * GET  /health        → ヘルスチェック
 */
import express from 'express'
import { submitForm } from './form-submitter.js'
import { checkFormType } from './form-checker.js'

const app = express()
const PORT = process.env.PLAYWRIGHT_SERVICE_PORT || 3001

app.use(express.json({ limit: '10mb' }))

// ヘルスチェック
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

/**
 * F-07: フォーム自動送信
 *
 * リクエスト:
 * {
 *   formUrl: string,           // フォームページURL
 *   companyName: string,       // 会社名（スクショのファイル名に使用）
 *   message: string,           // 送信する営業文章
 *   senderName: string,        // 送信者名
 *   senderEmail: string,       // 送信者メール
 *   senderCompany: string,     // 送信者会社名
 *   messageLength: 500 | 3000  // 文字数制限（フォームの文字数制限に応じて自動選択）
 * }
 *
 * レスポンス:
 * {
 *   success: boolean,
 *   screenshotBase64: string | null,  // 送信完了画面のPNG（Base64）
 *   submittedAt: string,
 *   error: string | null
 * }
 */
app.post('/submit-form', async (req, res) => {
  const { formUrl, companyName, message, senderName, senderEmail, senderCompany } = req.body

  if (!formUrl || !message) {
    return res.status(400).json({ success: false, error: 'formUrl と message は必須です' })
  }

  console.log(`[submit] 開始: ${companyName} | ${formUrl}`)

  try {
    const result = await submitForm({
      formUrl,
      companyName,
      message,
      senderName: senderName || process.env.SENDER_NAME || '株式会社REMEDY',
      senderEmail: senderEmail || process.env.SENDER_EMAIL || '',
      senderCompany: senderCompany || process.env.SENDER_COMPANY || '株式会社REMEDY'
    })

    console.log(`[submit] ${result.success ? '✅ 成功' : '❌ 失敗'}: ${companyName}`)
    res.json(result)
  } catch (error) {
    console.error(`[submit] エラー: ${companyName}`, error.message)
    res.status(500).json({ success: false, error: error.message, screenshotBase64: null })
  }
})

/**
 * F-10: フォーム種別チェック（予約フォーム除外）
 *
 * リクエスト: { url: string }
 * レスポンス: { type: 'inquiry' | 'booking' | 'unknown', reason: string }
 */
app.post('/check-form', async (req, res) => {
  const { url } = req.body
  if (!url) return res.status(400).json({ error: 'url は必須です' })

  try {
    const result = await checkFormType(url)
    res.json(result)
  } catch (error) {
    res.status(500).json({ type: 'unknown', error: error.message })
  }
})

app.listen(PORT, () => {
  console.log(`✅ Playwright サービス起動: http://localhost:${PORT}`)
})
