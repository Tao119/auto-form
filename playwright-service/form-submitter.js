import { chromium } from 'playwright'

const TIMEOUT = 15000

/**
 * F-07: Playwright によるフォーム自動入力・送信
 *
 * 戦略:
 *  1. お名前・会社名・メール・電話・本文フィールドを検出・入力
 *  2. 文字数制限を自動検出して 500字 or 3000字版を自動選択
 *  3. 送信ボタンをクリック
 *  4. 送信完了画面をスクショ
 */
export async function submitForm({ formUrl, companyName, message, senderName, senderEmail, senderCompany }) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  })

  let screenshotBase64 = null

  try {
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo'
    })
    const page = await context.newPage()

    await page.goto(formUrl, { waitUntil: 'domcontentloaded', timeout: TIMEOUT })
    await page.waitForTimeout(1500)

    // ===== フィールド入力 =====

    // お名前
    await fillField(page, NAME_SELECTORS, senderName)

    // 会社名
    await fillField(page, COMPANY_SELECTORS, senderCompany)

    // メールアドレス
    await fillField(page, EMAIL_SELECTORS, senderEmail)

    // 本文（文字数制限を考慮）
    const bodyFilled = await fillBodyField(page, message)
    if (!bodyFilled) {
      throw new Error('本文フィールドが見つかりませんでした')
    }

    // ===== 送信前スクショ（確認用）=====
    const beforeShot = await page.screenshot({ type: 'png', fullPage: false })

    // ===== 送信ボタンをクリック =====
    const submitted = await clickSubmitButton(page)
    if (!submitted) {
      throw new Error('送信ボタンが見つかりませんでした')
    }

    // 送信後の画面遷移を待つ
    await page.waitForTimeout(3000)

    // ===== 完了画面のスクショ =====
    const afterShot = await page.screenshot({ type: 'png', fullPage: true })
    screenshotBase64 = afterShot.toString('base64')

    // 送信完了を確認
    const pageText = await page.innerText('body').catch(() => '')
    const isSuccess = isSuccessPage(pageText)

    return {
      success: isSuccess,
      screenshotBase64,
      submittedAt: new Date().toISOString(),
      error: isSuccess ? null : '完了ページへの遷移を確認できませんでした（目視確認推奨）'
    }
  } finally {
    await browser.close()
  }
}

// ===== フィールド検出ヘルパー =====

const NAME_SELECTORS = [
  'input[name*="name" i]', 'input[name*="名前"]', 'input[id*="name" i]',
  'input[placeholder*="お名前"]', 'input[placeholder*="氏名"]',
  'input[name="your-name"]', 'input[name="contact-name"]'
]

const COMPANY_SELECTORS = [
  'input[name*="company" i]', 'input[name*="会社"]', 'input[id*="company" i]',
  'input[placeholder*="会社名"]', 'input[placeholder*="会社・組織名"]',
  'input[name="your-company"]'
]

const EMAIL_SELECTORS = [
  'input[type="email"]', 'input[name*="email" i]', 'input[name*="mail" i]',
  'input[id*="email" i]', 'input[placeholder*="メール"]',
  'input[name="your-email"]', 'input[name="contact-email"]'
]

const BODY_SELECTORS = [
  'textarea[name*="message" i]', 'textarea[name*="body" i]',
  'textarea[name*="content" i]', 'textarea[name*="お問い合わせ"]',
  'textarea[name*="内容"]', 'textarea[id*="message" i]',
  'textarea[placeholder*="お問い合わせ内容"]', 'textarea[placeholder*="ご質問"]',
  'textarea[name="your-message"]', 'textarea'
]

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("送信")',
  'button:has-text("確認")',
  'button:has-text("Submit")',
  'input[value*="送信"]',
  'input[value*="確認"]',
  '*[class*="submit"]'
]

async function fillField(page, selectors, value) {
  if (!value) return false
  for (const sel of selectors) {
    try {
      const el = page.locator(sel).first()
      if (await el.count() > 0 && await el.isVisible({ timeout: 1000 })) {
        await el.fill(value)
        return true
      }
    } catch { continue }
  }
  return false
}

async function fillBodyField(page, message) {
  for (const sel of BODY_SELECTORS) {
    try {
      const el = page.locator(sel).first()
      if (await el.count() > 0 && await el.isVisible({ timeout: 1000 })) {
        // maxlength 属性を確認して文字数を調整
        const maxLength = await el.getAttribute('maxlength').catch(() => null)
        const limit = maxLength ? parseInt(maxLength) : Infinity
        const text = limit < 600 ? message.slice(0, 490) : message
        await el.fill(text)
        return true
      }
    } catch { continue }
  }
  return false
}

async function clickSubmitButton(page) {
  for (const sel of SUBMIT_SELECTORS) {
    try {
      const el = page.locator(sel).first()
      if (await el.count() > 0 && await el.isVisible({ timeout: 1000 })) {
        await el.click()
        return true
      }
    } catch { continue }
  }
  return false
}

function isSuccessPage(text) {
  const successKeywords = ['送信完了', '送信しました', 'ありがとうございます', 'お問い合わせを受け付け',
    'Thank you', 'sent successfully', '完了', '受付']
  return successKeywords.some(kw => text.includes(kw))
}
