import { chromium } from 'playwright'

/**
 * F-10: フォーム種別チェック（予約フォーム除外）
 * Playwright でページを開いてDOMを確認し、予約フォームかどうかを判定
 */
export async function checkFormType(url) {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] })

  try {
    const page = await browser.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10000 })

    const text = await page.innerText('body').catch(() => '')
    const html = await page.content().catch(() => '')

    const bookingSignals = [
      '予約', 'ご予約', '来店予約', '施術予約', '日時を選択',
      'カレンダー', '時間帯', 'reservation', 'booking',
      'ホットペッパー', 'HOT PEPPER', '楽天ビューティー',
      'calendar', 'datepicker', 'timepicker'
    ]

    const inquirySignals = [
      'お問い合わせ', 'ご質問', 'ご相談', 'お見積もり', '資料請求',
      'contact', 'inquiry', 'メッセージ', 'ご意見'
    ]

    const bookingScore = bookingSignals.filter(kw =>
      text.toLowerCase().includes(kw.toLowerCase()) ||
      html.toLowerCase().includes(kw.toLowerCase())
    ).length

    const inquiryScore = inquirySignals.filter(kw =>
      text.toLowerCase().includes(kw.toLowerCase())
    ).length

    if (bookingScore >= 2) {
      return { type: 'booking', reason: `予約シグナル${bookingScore}件検出` }
    } else if (inquiryScore > 0) {
      return { type: 'inquiry', reason: `問い合わせシグナル${inquiryScore}件検出` }
    }

    return { type: 'unknown', reason: '判定不能' }
  } finally {
    await browser.close()
  }
}
