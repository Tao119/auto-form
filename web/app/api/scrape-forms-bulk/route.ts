import { NextRequest, NextResponse } from 'next/server'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { z } from 'zod'

const Schema = z.object({
  items: z.array(z.object({
    url: z.string(),       // HP URL to fetch
    baseUrl: z.string(),   // same as url (used as base for relative links)
  })).min(1),
  timeoutMs: z.number().int().min(1000).max(30000).default(8000),
  concurrency: z.number().int().min(1).max(100).default(30),
  fetchFormPage: z.boolean().default(true), // also fetch the detected form page
})

interface FetchResult {
  url: string
  html: string
  error: string | null
  statusCode: number | null
}

export interface FormExtractResult {
  url: string
  baseUrl: string
  formUrl: string | null
  email: string | null
  phone: string | null
  hasContactLink: boolean
  hasInlineForm: boolean
  hasEmailContact: boolean
  contactLinks: Array<{ url: string; text: string; score: number }>
  formPageText: string | null  // cleaned text from form page (for GPT)
  formPageTitle: string | null
  error: string | null
}

function fetchUrl(rawUrl: string, timeoutMs: number): Promise<FetchResult> {
  return new Promise((resolve) => {
    let resolved = false
    const done = (result: FetchResult) => {
      if (!resolved) { resolved = true; resolve(result) }
    }

    if (!rawUrl || !rawUrl.startsWith('http')) {
      return done({ url: rawUrl, html: '', error: 'invalid_url', statusCode: null })
    }

    let parsedUrl: URL
    try { parsedUrl = new URL(rawUrl) }
    catch { return done({ url: rawUrl, html: '', error: 'invalid_url', statusCode: null }) }

    const mod = parsedUrl.protocol === 'https:' ? https : http
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.5',
        'Accept-Encoding': 'identity',
      },
      rejectUnauthorized: false,
    }

    const tid = setTimeout(() => done({ url: rawUrl, html: '', error: 'timeout', statusCode: null }), timeoutMs + 500)

    try {
      const req = mod.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(tid)
          try {
            const redirectUrl = new URL(res.headers.location, rawUrl).toString()
            fetchUrl(redirectUrl, timeoutMs).then((r) => done({ ...r, url: rawUrl }))
          } catch {
            done({ url: rawUrl, html: '', error: 'bad_redirect', statusCode: res.statusCode })
          }
          return
        }

        const chunks: Buffer[] = []
        let totalBytes = 0
        const MAX_BYTES = 200_000 // 200KB sufficient for link scanning

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (totalBytes <= MAX_BYTES) { chunks.push(chunk) } else { res.destroy() }
        })
        res.on('end', () => {
          clearTimeout(tid)
          done({ url: rawUrl, html: Buffer.concat(chunks).toString('utf8'), error: null, statusCode: res.statusCode ?? null })
        })
        res.on('error', (e) => { clearTimeout(tid); done({ url: rawUrl, html: '', error: e.message, statusCode: null }) })
      })

      req.on('error', (e) => { clearTimeout(tid); done({ url: rawUrl, html: '', error: e.message, statusCode: null }) })
      req.on('timeout', () => { req.destroy(); clearTimeout(tid); done({ url: rawUrl, html: '', error: 'socket_timeout', statusCode: null }) })
      req.setTimeout(timeoutMs)
      req.end()
    } catch (e) {
      clearTimeout(tid)
      done({ url: rawUrl, html: '', error: String(e), statusCode: null })
    }
  })
}

function cleanHtmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 3000) // GPT only needs the first ~3000 chars
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  return m ? m[1].trim() : ''
}

function extractForms(html: string, baseUrl: string): {
  formUrl: string | null
  email: string | null
  phone: string | null
  hasContactLink: boolean
  hasInlineForm: boolean
  hasEmailContact: boolean
  contactLinks: Array<{ url: string; text: string; score: number }>
} {
  const CONTACT_TEXT_KW = [
    'お問い合わせ','contact','問い合わせ','ご相談','メールフォーム','inquiry',
    'ご連絡','メール送信','連絡','toiawase','mail','メッセージ','無料相談',
    '資料請求','ご質問','お問合せ','お問合わせ','ご意見','ご要望','feedback',
    'renraku','goiken','send message','write to us','get in touch',
  ]
  const CONTACT_URL_KW = [
    'contact','inquiry','toiawase','otoiawase','form','mailform','mail',
    'ask','support','feedback','renraku','goiken','send','message',
    'お問い合わせ','問い合わせ','ご相談','ご連絡','cgi-bin','cgi/',
  ]
  const BOOKING_KW = [
    '予約','ご予約','reservation','booking','ネット予約','hotpepper',
    'reserve','yoyaku','minimo','beauty.hotpepper',
  ]
  const EXTERNAL_FORM_HOSTS = [
    'docs.google.com','forms.gle','form.run','formstack.com','typeform.com',
    'jotform.com','tayori.com','form.kintoneapp.com','coubic.com',
    'airreserve.net','lin.ee','page.line.me','tally.so','paperform.co',
  ]

  const hasInlineForm = /<form[\s>]/i.test(html) && (
    /textarea|<input[^>]+type=["']?(text|email|tel)/i.test(html) ||
    /お問い合わせ|ご連絡|ご相談|メッセージ|送信/i.test(html)
  )

  const linkRegex = /<a([^>]*)>([\s\S]*?)<\/a>/gi
  const links: Array<{ url: string; text: string; score: number }> = []
  let match: RegExpExecArray | null

  while ((match = linkRegex.exec(html)) !== null) {
    const attrStr = match[1] || ''
    const innerHtml = match[2] || ''

    const hrefM = attrStr.match(/href=["']([^"'#][^"']*)['"]/i)
    if (!hrefM) continue
    const rawHref = hrefM[1].trim()
    if (!rawHref || rawHref.startsWith('javascript') || rawHref.startsWith('tel:') || rawHref.startsWith('mailto:')) continue

    const textSources = [
      innerHtml.replace(/<[^>]+>/g, ' ').trim(),
      (attrStr.match(/aria-label=["']([^"']+)['"]/i) || [])[1] || '',
      (attrStr.match(/title=["']([^"']+)['"]/i) || [])[1] || '',
      ...[...innerHtml.matchAll(/alt=["']([^"']+)['"]/gi)].map((m) => m[1]),
    ]
    const rawText = textSources.join(' ').replace(/\s+/g, ' ').trim()

    let absoluteUrl: string
    let isExternal = false
    try {
      absoluteUrl = new URL(rawHref, baseUrl).toString()
      const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '')
      const linkHost = new URL(absoluteUrl).hostname.replace(/^www\./, '')
      isExternal = baseHost !== linkHost
      if (isExternal && !EXTERNAL_FORM_HOSTS.some((h) => linkHost.includes(h))) continue
    } catch { continue }

    const lText = rawText.toLowerCase()
    const lUrl = absoluteUrl.toLowerCase()

    const isBooking = BOOKING_KW.some((kw) => lText.includes(kw.toLowerCase()) || lUrl.includes(kw.toLowerCase()))
    if (isBooking) continue

    let score = 0
    for (const kw of CONTACT_TEXT_KW) { if (lText.includes(kw.toLowerCase())) { score += 10; break } }
    for (const kw of CONTACT_URL_KW) { if (lUrl.includes(kw.toLowerCase())) { score += 8; break } }
    if (/\/(contact|inquiry|toiawase|otoiawase|mailform|mail|form|ask|feedback|support)(\/|\.|$|\?)/i.test(absoluteUrl)) score += 5
    if (/\/cgi(-bin)?\/.*form/i.test(absoluteUrl)) score += 12
    if (isExternal) score += 15

    if (score > 0) links.push({ url: absoluteUrl, text: rawText.slice(0, 80), score })
  }
  links.sort((a, b) => b.score - a.score)

  const mailtoM = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
  const emailM = html.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-z]{2,4})/)
  const email = mailtoM ? mailtoM[1] : emailM ? emailM[1] : null

  const phoneM = html.match(/tel:([0-9\-+\s()]{8,15})/i) || html.match(/(0[0-9]{1,4}[-\s][0-9]{2,4}[-\s][0-9]{3,4})/)
  const phone = phoneM ? phoneM[1].replace(/\s/g, '').trim() : null

  let hasContactLink = links.length > 0
  let formUrl: string | null = links.length > 0 ? links[0].url : null

  if (!hasContactLink && hasInlineForm) {
    formUrl = baseUrl
    hasContactLink = true
  }

  const hasEmailContact = !!email
  if (!hasContactLink && hasEmailContact) {
    formUrl = baseUrl || null
    hasContactLink = true
  }

  return { formUrl, email, phone, hasContactLink, hasInlineForm, hasEmailContact, contactLinks: links.slice(0, 3) }
}

async function processItem(
  url: string,
  baseUrl: string,
  timeoutMs: number,
  fetchFormPage: boolean
): Promise<FormExtractResult> {
  // Step 1: fetch HP
  const hpFetch = await fetchUrl(url, timeoutMs)
  if (hpFetch.error || !hpFetch.html) {
    return {
      url, baseUrl,
      formUrl: null, email: null, phone: null,
      hasContactLink: false, hasInlineForm: false, hasEmailContact: false,
      contactLinks: [], formPageText: null, formPageTitle: null,
      error: hpFetch.error,
    }
  }

  // Step 2: extract form links
  const extracted = extractForms(hpFetch.html, baseUrl)

  // Step 3: optionally fetch form page
  let formPageText: string | null = null
  let formPageTitle: string | null = null

  if (fetchFormPage && extracted.formUrl && extracted.hasContactLink) {
    try {
      const formFetch = await fetchUrl(extracted.formUrl, timeoutMs)
      if (formFetch.html) {
        formPageText = cleanHtmlToText(formFetch.html)
        formPageTitle = extractTitle(formFetch.html)
      }
    } catch { /* ignore form page fetch failures */ }
  }

  return { url, baseUrl, ...extracted, formPageText, formPageTitle, error: null }
}

async function processBatch(
  items: Array<{ url: string; baseUrl: string }>,
  timeoutMs: number,
  concurrency: number,
  fetchFormPage: boolean
): Promise<FormExtractResult[]> {
  const results: FormExtractResult[] = []
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)
    const batchResults = await Promise.all(
      batch.map(({ url, baseUrl }) => processItem(url, baseUrl, timeoutMs, fetchFormPage))
    )
    results.push(...batchResults)
  }
  return results
}

export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json())
    const { items, timeoutMs, concurrency, fetchFormPage } = body

    const startMs = Date.now()
    const results = await processBatch(items, timeoutMs, concurrency, fetchFormPage)
    const elapsedMs = Date.now() - startMs

    const successCount = results.filter((r) => r.error === null).length
    const formFoundCount = results.filter((r) => r.hasContactLink).length

    return NextResponse.json({
      success: true,
      results,
      meta: {
        total: results.length,
        successCount,
        errorCount: results.length - successCount,
        formFoundCount,
        formFoundRate: Math.round((formFoundCount / Math.max(results.length, 1)) * 100),
        elapsedMs,
        avgMs: Math.round(elapsedMs / Math.max(results.length, 1)),
      },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
