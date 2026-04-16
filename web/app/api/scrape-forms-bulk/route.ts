import { NextRequest, NextResponse } from 'next/server'
import * as https from 'https'
import * as http from 'http'
import * as zlib from 'zlib'
import { URL } from 'url'
import { z } from 'zod'

// ── Global concurrency guard ───────────────────────────────────────
// Allow at most MAX_CONCURRENT_BATCHES simultaneous scraping jobs to
// prevent runaway memory / CPU usage when n8n fires multiple webhooks.
const MAX_CONCURRENT_BATCHES = 2
let _activeBatches = 0

// ── Per-IP sliding-window rate limiter ─────────────────────────────
// Limits the scrape endpoint to RATE_LIMIT_MAX calls per RATE_LIMIT_WINDOW_MS
// per client IP to prevent accidental or malicious abuse.
// Using a Map keyed by IP with a list of timestamps for the sliding window.
const RATE_LIMIT_WINDOW_MS = 60_000  // 1 minute
const RATE_LIMIT_MAX       = 20      // max calls per minute per IP
const _rateMap = new Map<string, number[]>()

function checkRateLimit(ip: string): { allowed: boolean; remaining: number; resetMs: number } {
  const now = Date.now()
  const windowStart = now - RATE_LIMIT_WINDOW_MS
  const hits = (_rateMap.get(ip) ?? []).filter((t) => t > windowStart)
  if (hits.length >= RATE_LIMIT_MAX) {
    const resetMs = hits[0] + RATE_LIMIT_WINDOW_MS - now
    return { allowed: false, remaining: 0, resetMs }
  }
  hits.push(now)
  _rateMap.set(ip, hits)
  // Periodically evict expired entries to prevent unbounded map growth
  if (_rateMap.size > 1000) {
    for (const [k, v] of _rateMap) {
      if (v.every((t) => t <= windowStart)) _rateMap.delete(k)
    }
  }
  return { allowed: true, remaining: RATE_LIMIT_MAX - hits.length, resetMs: 0 }
}

// ── Shared HTTP agents with keep-alive ────────────────────────────
// Connection reuse significantly reduces latency for sequential fetches to the
// same host (HP fetch → form page validation → probe paths).
const _httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32 })
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, rejectUnauthorized: false })

// ── Contact extraction constants ──────────────────────────────────────────────
// Defined at module scope to avoid re-allocation on every request
// (extractForms and validateFormPage are called multiple times per item).

// High-confidence Japanese inquiry keywords (+12 points, strongest signal)
const CONTACT_TEXT_KW_STRONG = [
  'お問い合わせ','お問合わせ','お問合せ','問い合わせフォーム','ご相談フォーム',
  'メールフォーム','お問い合わせフォーム','お問合せフォーム',
]
// Standard inquiry keywords (+10 points)
const CONTACT_TEXT_KW = [
  'otoiawase','contact us','contact form','inquiry form','inquiry','enquiry',
  'ご相談','メール送信','renraku','goiken','ご連絡',
  '無料相談','資料請求','send message','write to us','get in touch',
  'お申し込み','ご依頼','お見積もり','見積もり依頼','メールでのお問合',
]
// Looser keywords (+6 points — need URL keyword to reach inclusion threshold of 8)
const CONTACT_TEXT_KW_LOOSE = ['contact','feedback','お問合','toiawase']
const ALWAYS_REJECT_HOSTS = [
  'facebook.com','fb.com','instagram.com','twitter.com','x.com',
  'linkedin.com','tiktok.com','youtube.com','pinterest.com',
  'maps.google.com','google.co.jp','google.com','maps.apple.com',
  'amazon.co.jp','amazon.com','rakuten.co.jp','yahoo.co.jp',
  'drive.google.com','dropbox.com','onedrive.com',
  'apple.com',
]
const BOOKING_KW = [
  '予約','ご予約','reservation','booking','ネット予約','hotpepper',
  'reserve','yoyaku','minimo','beauty.hotpepper',
  'ご来店予約','来店予約','席の予約','テーブル予約','席予約',
  'ご予約はこちら','ご来店はこちら','予約フォーム',
]
const BOOKING_URL_HOSTS = [
  'coubic.com','airreserve.net','reserva.be','minimo.io',
  'tablecheck.com','ebica.jp','toreta.in','hotpepper.jp',
  'beauty.hotpepper.jp','select-type.com','icalendar.jp',
  'reservestock.jp','reservia.jp',
  'epark.jp','eparkeclinic.jp',
  'reservawith.google.com','business.google.com',
  'caresul.jp','freqy.jp','benri-yoyaku.jp','chouseisan.com',
  'jalan.net','ikyu.com','hotels.com','booking.com','agoda.com',
  'airbnb.com','airbnb.jp',
  'tabelog.com','gnavi.co.jp','gurunavi.com',
  'tripadvisor.com','tripadvisor.jp',
  'yelp.com','retty.me','loco.yahoo.co.jp',
  // Additional Japanese salon/beauty booking services
  'salon-board.jp','salonconnect.jp',
  'yoyakucast.com','reserve.relo-system.com',
  'yoyaku.yahoo.co.jp',
  'ozmall.co.jp',
  // Restaurant / hotel booking
  'venue-search.com',
  'r.gnavi.co.jp',
  // Global scheduling services (calendars / appointment booking, not contact forms)
  'calendly.com','cal.com','acuityscheduling.com','doodle.com',
  'tidycal.com','oncehub.com','appointlet.com','bookafy.com',
  'setmore.com','10to8.com','vcita.com','booksy.com',
  // Additional booking / scheduling services
  'squareup.com',
  'classpass.com','vagaro.com',
]
const EXTERNAL_FORM_HOSTS = [
  'docs.google.com','forms.gle',
  'form.run','formrun.com','tayori.com','form.kintoneapp.com','kintone.com',
  'formzu.net','freeml.net','formmailer.jp',
  'formstack.com','typeform.com','jotform.com','tally.so','paperform.co',
  'wufoo.com','surveymonkey.com','cognito-forms.com',
  'share.hsforms.com','forms.hubspot.com',
  'share.formsite.com',
  'app.getresponse.com',
  'lin.ee','page.line.me','accountpage.line.me','liff.line.me',
  'mailchimp.com','zoho.com',
  'forms.office.com','forms.microsoft.com',
  '123formbuilder.com','formassembly.com',
  'forms.app','tripetto.app',
  // Japanese form services missing from the fast-pass list
  'mfcontact.com','mfcontacts.com','mailform.jp',
  // Additional Japanese form/CRM services
  'gmomakeform.com','formhub.jp','questant.jp',
  'sendinblue.com','brevo.com',
  'f-formz.com','ws.formzu.net',
  // SPIRAL: major Japanese form/CRM platform — forms embedded as iframes or direct links
  'spiral.ne.jp','spiral-forms.net',
  // WEBCAS: Japanese multichannel contact management
  'webcas.net',
  // n-form: popular Japanese contact form builder
  'n-form.jp','secure.n-form.jp',
  // Salesforce Web-to-Lead (common in Japanese B2B sites)
  'webto.salesforce.com',
  // Elfsight: embedded contact widget forms
  'elfsight.com',
  // Additional Japanese form hosting services
  'plus.form-mailer.jp',
  // Adobe Experience Manager Forms (large enterprises)
  'experience.adobe.com',
]
// URL path suffixes that clearly indicate non-contact pages.
// Trailing boundary (\/|\.|\?|$) prevents partial matches: /recruit-info is NOT rejected.
const NON_CONTACT_SUFFIX_RE = /\/(privacy[-_]?(?:policy)?|terms?(?:[-_]of[-_]service)?|sitemap|blog|news|articles?|posts?|column|archive|categories?|shop|cart|login|sign[-_]?up|register|logout|faq|access(?:map)?|recruit(?:ment)?|career|jobs?|about(?:-us)?|company|profile|gallery|works|portfolio|media|press|staff|team|members?|events?|downloads?|videos?|photos?|voice(?:s)?|search|checkout|product(?:s)?|service(?:s)?|feature(?:s)?|pricing|plan(?:s)?|case[-_]?stud(?:y|ies)|testimonial(?:s)?|partner(?:s)?|investor(?:s)?|ir\b|sustainability|csr|history|overview|mission|vision|values?|review(?:s)?|interview(?:s)?|seminar(?:s)?|workshop(?:s)?|award(?:s)?|flow|guide(?:s)?|howto|how[-_]to|notification(?:s)?|release(?:s)?|legal|policy|cookie(?:[-_]policy)?|disclaimer|terms[-_]?conditions?|tag(?:s)?|topic(?:s)?|author(?:s)?|category|page\/\d|feed(?:\/|$)|rss(?:\/|$)|wp-admin|wp-login|wp-json|404|500|sitemap\.xml)(?:\/|\.|\?|$)/i
// URL segment patterns that strongly suggest a dedicated contact page
const URL_SEGMENT_RE = /(?:^|\/)(contact|inquiry|enquiry|enquire|inquire|toiawase|otoiawase|mailform|formmail|form[-_]mail|ask-us|askus|feedback|renraku|goiken|iawase|gorenraku|gosodan|soudan|meiru|consultation|message|contactus|contactform|inquiryform|mailsend|sendmail|getintouch|get-in-touch|write-to-us|writeto|mailsend|formcontact|contactmail|otoiawase[-_]form|toiawase[-_]form|form[-_]otoiawase|form[-_]toiawase|free[-_]consultation|online[-_]inquiry|web[-_]inquiry|online[-_]contact|web[-_]contact)(?:\/|\.|\?|_|-|$)/i
const URL_LOOSE_RE = /(?:%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B|%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B|%E3%81%94%E7%9B%B8%E8%AB%87|%E3%81%94%E9%80%A3%E7%B5%A1|cgi-bin|cgi\/)/i
// LINE deep-link patterns — always valid contact method, skip HTTP validation
const LINE_HINT_PATTERNS = [/lin\.ee\//i, /page\.line\.me\//i, /accountpage\.line\.me\//i, /liff\.line\.me\//i]
const LINE_URL_RE = /^https?:\/\/(lin\.ee|page\.line\.me|accountpage\.line\.me|liff\.line\.me)\//i
const LINE_CONTACT_RE = /lin\.ee\/|page\.line\.me\/|accountpage\.line\.me\/|liff\.line\.me\//i
// Redirect destinations that indicate the target URL is NOT an inquiry form
const REDIRECT_REJECT_HOSTS = [
  'coubic.com','airreserve.net','reserva.be','minimo.io',
  'tablecheck.com','ebica.jp','toreta.in','hotpepper.jp',
  'beauty.hotpepper.jp','select-type.com','icalendar.jp',
  'reservestock.jp','reservia.jp',
  'epark.jp','eparkeclinic.jp',
  'reservawith.google.com','business.google.com',
  'caresul.jp','freqy.jp','benri-yoyaku.jp','chouseisan.com',
  'jalan.net','ikyu.com','hotels.com','booking.com','agoda.com','airbnb.com','airbnb.jp',
  'tabelog.com','gnavi.co.jp','gurunavi.com',
  'tripadvisor.com','tripadvisor.jp',
  'yelp.com','retty.me','loco.yahoo.co.jp',
  'facebook.com','instagram.com','twitter.com','x.com','linkedin.com',
  'tiktok.com','youtube.com','pinterest.com','maps.google.com',
  'calendly.com','cal.com','acuityscheduling.com','doodle.com',
  'tidycal.com','oncehub.com','appointlet.com','setmore.com',
  // Additional scheduling services matching BOOKING_URL_HOSTS above
  'squareup.com','classpass.com','vagaro.com',
]
// Fast-pass for known external form SaaS — page is a valid contact form without further analysis
const EXTERNAL_FORM_FAST_PASS_RE = /docs\.google\.com\/forms|forms\.gle|form\.run|formrun\.com|typeform\.com|jotform\.com|tayori\.com|formstack\.com|formzu\.net|form\.kintoneapp|kintone\.com|freeml\.net|mailform\.jp|mfcontact\.com|mfcontacts\.com|formmailer\.jp|tally\.so|paperform\.co|cognito-forms\.com|wufoo\.com|surveymonkey\.com|share\.hsforms\.com|forms\.hubspot\.com|share\.formsite\.com|app\.getresponse\.com|mailchimp\.com|zoho\.com|forms\.office\.com|forms\.microsoft\.com|123formbuilder\.com|formassembly\.com|forms\.app|tripetto\.app|gmomakeform\.com|formhub\.jp|questant\.jp|sendinblue\.com|brevo\.com|f-formz\.com|ws\.formzu\.net|spiral\.ne\.jp|spiral-forms\.net|webcas\.net|n-form\.jp|secure\.n-form\.jp|webto\.salesforce\.com|elfsight\.com|plus\.form-mailer\.jp/i

const Schema = z.object({
  items: z.array(z.object({
    url: z.string(),       // HP URL to fetch
    baseUrl: z.string(),   // same as url (used as base for relative links)
  })).min(1).max(500),    // safety cap: prevent OOM from oversized requests
  timeoutMs: z.number().int().min(1000).max(30000).default(8000),
  concurrency: z.number().int().min(1).max(100).default(30),
  fetchFormPage: z.boolean().default(true), // also fetch the detected form page
})

interface FetchResult {
  url: string
  finalUrl: string   // actual URL after following redirects (same as url if no redirect)
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
  address: string | null
  hasContactLink: boolean
  hasInlineForm: boolean
  hasEmailContact: boolean
  contactLinks: Array<{ url: string; text: string; score: number }>
  formPageText: string | null  // cleaned text from form page (for GPT)
  formPageTitle: string | null
  formTypeHint: 'inquiry' | 'booking' | 'LINE' | null  // detected form type hint
  error: string | null
}

/**
 * Detect charset from Content-Type header and/or <meta charset> tag, then decode buffer.
 * Handles Shift-JIS (cp932/windows-31j), EUC-JP, and UTF-8/ISO-8859-1.
 * Falls back to UTF-8 when detection is inconclusive.
 */
function decodeBuffer(buf: Buffer, contentTypeHeader: string): string {
  // 1. Try Content-Type header first (most authoritative)
  const ctCharset = contentTypeHeader.match(/charset=["']?([\w\-]+)/i)?.[1]?.toLowerCase() ?? ''

  // 2. Scan first 2 KB as Latin-1 for meta charset (safe: HTML headers are ASCII-compatible)
  const previewLatin = buf.slice(0, 2000).toString('latin1')
  // <meta charset="Shift_JIS"> or <meta http-equiv="Content-Type" content="...; charset=Shift_JIS">
  const metaCharset = (
    previewLatin.match(/<meta[^>]+charset=["']?([\w\-]+)/i)?.[1] ??
    previewLatin.match(/charset=([\w\-]+)/i)?.[1] ??
    ''
  ).toLowerCase()

  const detected = ctCharset || metaCharset

  const normalise = (cs: string): string => {
    if (/shift.?jis|sjis|x-sjis|cp932|windows-31j|ms_kanji|csshiftjis/i.test(cs)) return 'windows-31j'
    if (/euc.?jp|x-euc|cseucpkdfmtjapanese/i.test(cs)) return 'euc-jp'
    if (/iso.?2022.?jp/i.test(cs)) return 'iso-2022-jp'
    return 'utf-8'
  }

  const charsetLabel = normalise(detected)
  if (charsetLabel === 'utf-8') return buf.toString('utf8')

  try {
    return new TextDecoder(charsetLabel).decode(buf)
  } catch {
    return buf.toString('utf8')
  }
}

/** Strip known tracking query parameters from a URL before storing/returning it. */
const TRACKING_QS = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','msclkid','ref','from','_ga','_gl','yclid','twclid'])
function stripTrackingParams(url: string): string {
  try {
    const u = new URL(url)
    TRACKING_QS.forEach((p) => u.searchParams.delete(p))
    return u.toString()
  } catch { return url }
}

function fetchUrl(rawUrl: string, timeoutMs: number, _depth = 0): Promise<FetchResult> {
  return new Promise((resolve) => {
    let resolved = false
    const done = (result: FetchResult) => {
      if (!resolved) { resolved = true; resolve(result) }
    }

    if (!rawUrl || !rawUrl.startsWith('http')) {
      return done({ url: rawUrl, finalUrl: rawUrl, html: '', error: 'invalid_url', statusCode: null })
    }
    if (_depth > 5) {
      return done({ url: rawUrl, finalUrl: rawUrl, html: '', error: 'too_many_redirects', statusCode: null })
    }

    let parsedUrl: URL
    try { parsedUrl = new URL(rawUrl) }
    catch { return done({ url: rawUrl, finalUrl: rawUrl, html: '', error: 'invalid_url', statusCode: null }) }

    const isHttps = parsedUrl.protocol === 'https:'
    const mod = isHttps ? https : http
    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (isHttps ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeoutMs,
      agent: isHttps ? _httpsAgent : _httpAgent,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
      },
    }

    const tid = setTimeout(() => done({ url: rawUrl, finalUrl: rawUrl, html: '', error: 'timeout', statusCode: null }), timeoutMs + 500)

    try {
      const req = mod.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(tid)
          try {
            const redirectUrl = new URL(res.headers.location, rawUrl).toString()
            // Recursive call: finalUrl from inner call is the true destination; override url with original
            fetchUrl(redirectUrl, timeoutMs, _depth + 1).then((r) => done({ ...r, url: rawUrl }))
          } catch {
            done({ url: rawUrl, finalUrl: rawUrl, html: '', error: 'bad_redirect', statusCode: res.statusCode })
          }
          return
        }

        const chunks: Buffer[] = []
        let totalBytes = 0
        // 200KB compressed — after decompression typically 600KB–1MB, sufficient for link scanning
        const MAX_BYTES = 200_000

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (totalBytes <= MAX_BYTES) { chunks.push(chunk) } else { res.destroy() }
        })
        res.on('end', () => {
          clearTimeout(tid)
          const rawBuf = Buffer.concat(chunks)
          const contentEncoding = (res.headers['content-encoding'] || '').toLowerCase()
          const contentType = (res.headers['content-type'] || '').toLowerCase()
          const processHtml = (decodedBuf: Buffer) => {
            // Charset-aware decoding: handles Shift-JIS, EUC-JP, ISO-2022-JP for old Japanese sites
            const html = decodeBuffer(decodedBuf, contentType)
            // Handle <meta http-equiv="refresh" content="0;url=..."> redirects (common on Japanese CMS)
            if (_depth <= 5) {
              const metaRefreshM = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']?\d*;\s*url=["']?([^"'\s>]+)/i)
              if (metaRefreshM) {
                try {
                  const metaUrl = new URL(metaRefreshM[1], rawUrl).toString()
                  if (metaUrl !== rawUrl) {
                    fetchUrl(metaUrl, timeoutMs, _depth + 1).then((r) => done({ ...r, url: rawUrl }))
                    return
                  }
                } catch { /* ignore malformed meta refresh */ }
              }
            }
            done({ url: rawUrl, finalUrl: rawUrl, html, error: null, statusCode: res.statusCode ?? null })
          }
          if (contentEncoding === 'gzip') {
            zlib.gunzip(rawBuf, (err, decoded) => processHtml(err ? rawBuf : decoded))
          } else if (contentEncoding === 'deflate') {
            zlib.inflate(rawBuf, (err, decoded) => processHtml(err ? rawBuf : decoded))
          } else if (contentEncoding === 'br') {
            zlib.brotliDecompress(rawBuf, (err, decoded) => processHtml(err ? rawBuf : decoded))
          } else {
            processHtml(rawBuf)
          }
        })
        res.on('error', (e) => { clearTimeout(tid); done({ url: rawUrl, finalUrl: rawUrl, html: '', error: e.message, statusCode: null }) })
      })

      req.on('error', (e) => { clearTimeout(tid); done({ url: rawUrl, finalUrl: rawUrl, html: '', error: e.message, statusCode: null }) })
      req.on('timeout', () => { req.destroy(); clearTimeout(tid); done({ url: rawUrl, finalUrl: rawUrl, html: '', error: 'socket_timeout', statusCode: null }) })
      req.setTimeout(timeoutMs)
      req.end()
    } catch (e) {
      clearTimeout(tid)
      done({ url: rawUrl, finalUrl: rawUrl, html: '', error: String(e), statusCode: null })
    }
  })
}

function stripHtmlTags(raw: string): string {
  return raw
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    // Strip noscript (fallback content for JS-disabled browsers, not relevant to form detection)
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')
    // Strip template tags (Vue/Angular component templates, not rendered HTML)
    .replace(/<template[\s\S]*?<\/template>/gi, '')
    // Preserve label text with a space separator (helps GPT understand form fields)
    .replace(/<label[^>]*>([\s\S]*?)<\/label>/gi, ' $1 ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract text for GPT classification.
 * Prioritises content around the first <form> tag so GPT sees
 * the labels and headings that describe the form, not just the page header.
 * Also prepends any <h1>/<h2> heading text from the page to give GPT page-level context.
 */
function cleanHtmlToText(html: string): string {
  // Extract the page heading (h1/h2) — gives GPT a strong signal about the page purpose
  const headings: string[] = []
  const headingRe = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi
  let hm: RegExpExecArray | null
  while ((hm = headingRe.exec(html)) !== null && headings.length < 3) {
    const text = hm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (text) headings.push(text)
  }

  const formIdx = html.toLowerCase().indexOf('<form')
  if (formIdx !== -1) {
    // Take 1 500 chars before the form (for headings/breadcrumbs) + 2 500 after
    const start = Math.max(0, formIdx - 1500)
    const end = Math.min(html.length, formIdx + 2500)
    const segment = html.slice(start, end)
    const body = stripHtmlTags(segment).slice(0, 2700)
    const header = headings.join(' / ')
    return header ? `${header}\n${body}` : body
  }
  const body = stripHtmlTags(html).slice(0, 2700)
  const header = headings.join(' / ')
  return header ? `${header}\n${body}` : body
}

function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return ''
  return m[1]
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function extractForms(html: string, baseUrl: string): {
  formUrl: string | null
  email: string | null
  phone: string | null
  address: string | null
  hasContactLink: boolean
  hasInlineForm: boolean
  hasEmailContact: boolean
  formTypeHint: 'inquiry' | 'booking' | 'LINE' | null
  contactLinks: Array<{ url: string; text: string; score: number }>
} {
  // Respect <base href="..."> tag — overrides the document's URL for all relative links.
  // Common on old Japanese sites using subdirectory CMS setups (e.g. <base href="/en/">).
  const baseHrefM = html.match(/<base[^>]+href=["']([^"']+)["']/i)
  const effectiveBase = baseHrefM ? (() => { try { return new URL(baseHrefM[1], baseUrl).toString() } catch { return baseUrl } })() : baseUrl

  // Require textarea (message field): filters out search boxes, login forms, newsletter signups
  const hasInlineForm = /<form[\s>]/i.test(html) && (
    /textarea/i.test(html) ||
    (/<input[^>]+type=["']?(email|tel)/i.test(html) &&
     /<(input|button)[^>]*type=["']?submit/i.test(html) &&
     /お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(html))
  )

  const linkRegex = /<a([^>]*)>([\s\S]*?)<\/a>/gi
  const links: Array<{ url: string; text: string; score: number }> = []
  let match: RegExpExecArray | null

  while ((match = linkRegex.exec(html)) !== null) {
    const attrStr = match[1] || ''
    const innerHtml = match[2] || ''

    // Support data-href / data-url / data-link as fallbacks (click-tracking wrappers on Japanese corporate sites)
    const hrefRaw = attrStr.match(/href=["']([^"'#][^"']*)['"]/i)?.[1]
      ?? attrStr.match(/data-href=["']([^"'#][^"']*)['"]/i)?.[1]
      ?? attrStr.match(/data-url=["']([^"'#][^"']*)['"]/i)?.[1]
      ?? attrStr.match(/data-link=["']([^"'#][^"']*)['"]/i)?.[1]
      // Last-resort: onclick="location.href='/contact'" style navigation
      ?? attrStr.match(/onclick=["'][^"']*(?:location\.href|window\.location(?:\.href)?)\s*=\s*["']([^"']+)["']/i)?.[1]
    if (!hrefRaw) continue
    const rawHref = hrefRaw.trim()
    if (!rawHref || rawHref.startsWith('javascript') || rawHref.startsWith('tel:') || rawHref.startsWith('mailto:')) continue

    const textSources = [
      innerHtml.replace(/<[^>]+>/g, ' ').trim(),
      (attrStr.match(/aria-label=["']([^"']+)['"]/i) || [])[1] || '',
      (attrStr.match(/title=["']([^"']+)['"]/i) || [])[1] || '',
      ...[...innerHtml.matchAll(/alt=["']([^"']+)['"]/gi)].map((m) => m[1]),
    ]
    const rawText = textSources.join(' ').replace(/\s+/g, ' ').trim()

    let absoluteUrl: string
    let linkHost = ''
    let isExternal = false
    try {
      const parsedLink = new URL(rawHref, effectiveBase)
      // Strip URL fragment — fragments are client-side only; servers always return the same page
      parsedLink.hash = ''
      absoluteUrl = parsedLink.toString()
      const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '')
      linkHost = new URL(absoluteUrl).hostname.replace(/^www\./, '')
      // Treat same-domain subdomains as internal (e.g. form.example.co.jp for example.co.jp)
      isExternal = baseHost !== linkHost && !linkHost.endsWith('.' + baseHost)
      // Immediately reject known non-form domains (SNS, maps, e-commerce, etc.)
      if (ALWAYS_REJECT_HOSTS.some((h) => linkHost === h || linkHost.endsWith('.' + h))) continue
      if (isExternal && !EXTERNAL_FORM_HOSTS.some((h) => linkHost.includes(h))) continue
    } catch { continue }

    const lText = rawText.toLowerCase()
    const lUrl = absoluteUrl.toLowerCase()

    // Reject booking links — but allow "予約・お問い合わせ" combined links
    const isBookingHost = BOOKING_URL_HOSTS.some((h) => linkHost.includes(h))
    const hasBookingKw = BOOKING_KW.some((kw) => lText.includes(kw.toLowerCase()) || lUrl.includes(kw.toLowerCase()))
    const hasInquiryKw = [...CONTACT_TEXT_KW_STRONG, ...CONTACT_TEXT_KW.slice(0, 10)].some((kw) => lText.includes(kw.toLowerCase()))
    // Host-based booking check is definitive; keyword-only check is rejected only if no inquiry keyword
    if (isBookingHost || (hasBookingKw && !hasInquiryKw)) continue

    // Reject links whose URL path clearly indicates non-contact content.
    if (NON_CONTACT_SUFFIX_RE.test(lUrl)) continue
    // Reject links that point to thank-you / completion pages (not a form, already submitted)
    if (/\/(thanks?|thankyou|thank[-_]you|complete[d]?|completion|sent|finish(?:ed)?|success|entry[-_]?complete)(?:\/|\.|\?|$)/i.test(lUrl)) continue

    let score = 0
    // Three-tier keyword scoring: strong (+12), standard (+10), loose (+6)
    let kwMatched = false
    for (const kw of CONTACT_TEXT_KW_STRONG) { if (lText.includes(kw.toLowerCase())) { score += 12; kwMatched = true; break } }
    if (!kwMatched) {
      for (const kw of CONTACT_TEXT_KW) { if (lText.includes(kw.toLowerCase())) { score += 10; kwMatched = true; break } }
    }
    if (!kwMatched) {
      for (const kw of CONTACT_TEXT_KW_LOOSE) { if (lText.includes(kw.toLowerCase())) { score += 6; break } }
    }

    // URL path matching: require word boundaries to avoid false positives
    // e.g. /contact, /contact.html, /contact/, /contact? but NOT /contactlist, /subcontract
    if (URL_SEGMENT_RE.test(lUrl) || URL_LOOSE_RE.test(lUrl)) score += 8
    // Also decode the URL and check for raw Japanese keywords
    try {
      const decoded = decodeURIComponent(lUrl)
      if (decoded.includes('お問い合わせ') || decoded.includes('問い合わせ') || decoded.includes('ご相談') || decoded.includes('ご連絡') || decoded.includes('お問合せ')) score += 8
    } catch { /* malformed URL */ }
    // Japanese URL keywords that might appear un-encoded
    if (lUrl.includes('お問い合わせ') || lUrl.includes('問い合わせ') || lUrl.includes('ご相談') || lUrl.includes('ご連絡')) score += 8
    // CGI form patterns common on Japanese sites (.cgi, .pl contact scripts)
    if (/\/cgi(-bin)?\/.*form/i.test(absoluteUrl)) score += 12
    if (/\/(mailform|form[_-]?mail|contact[_-]?form|inquiry|toiawase)\.(?:cgi|pl|php|aspx?)(?:\?|$)/i.test(absoluteUrl)) score += 10
    if (isExternal) score += 15
    // Subdomain contact bonus: contact.example.co.jp or form.example.co.jp
    if (!isExternal) {
      const linkSubdomain = new URL(absoluteUrl).hostname.split('.')[0].toLowerCase()
      if (/^(contact|inquiry|form|mail|toiawase|otoiawase)$/.test(linkSubdomain)) score += 8
    }

    // Score boost for links that appear inside a <footer> or <nav> element
    // (contact links in footers are very common; nav-level contact links are also reliable)
    const linkPos = match.index ?? -1
    const beforeLink = html.slice(0, linkPos).toLowerCase()
    const lastFooterOpen  = beforeLink.lastIndexOf('<footer')
    const lastFooterClose = beforeLink.lastIndexOf('</footer')
    if (lastFooterOpen > lastFooterClose) score += 4  // inside a footer
    const lastNavOpen  = beforeLink.lastIndexOf('<nav')
    const lastNavClose = beforeLink.lastIndexOf('</nav')
    if (lastNavOpen > lastNavClose) score += 2  // inside a nav

    // Require at least a URL keyword match (8) OR a strong text match (10) to accept
    if (score >= 8) links.push({ url: absoluteUrl, text: rawText.slice(0, 80), score })
  }

  // ── Button/div onclick contact navigation ────────────────────────
  // Modern Japanese sites often use <button onclick="location.href='/contact'"> or
  // <div role="button" onclick="..."> instead of <a href="...">.
  // Extract contact URLs from onclick attributes of non-<a> elements.
  const ONCLICK_ELEM_RE = /<(?:button|div|span|li)[^>]*onclick=["'][^"']*(?:location\.href|window\.location(?:\.href)?)\s*=\s*["']([^"']+)["'][^"'>]*>([^<]*)</gi
  let ocMatch: RegExpExecArray | null
  while ((ocMatch = ONCLICK_ELEM_RE.exec(html)) !== null) {
    const ocUrl = ocMatch[1]?.trim()
    const ocText = (ocMatch[2] || '').trim().toLowerCase()
    if (!ocUrl || ocUrl.startsWith('javascript')) continue
    try {
      const parsedOc = new URL(ocUrl, effectiveBase)
      parsedOc.hash = ''
      const absOcUrl = parsedOc.toString()
      const lOcUrl = absOcUrl.toLowerCase()
      // Only accept if the URL or text has a contact keyword
      if (URL_SEGMENT_RE.test(lOcUrl) || CONTACT_TEXT_KW_STRONG.some((kw) => ocText.includes(kw)) || CONTACT_TEXT_KW.some((kw) => ocText.includes(kw.toLowerCase()))) {
        const ocHost = parsedOc.hostname.replace(/^www\./, '')
        const baseHost = new URL(baseUrl).hostname.replace(/^www\./, '')
        if (ocHost === baseHost || ocHost.endsWith('.' + baseHost) || EXTERNAL_FORM_HOSTS.some((h) => ocHost.includes(h))) {
          links.push({ url: absOcUrl, text: (ocMatch[2] || '').trim().slice(0, 80), score: 10 })
        }
      }
    } catch { /* ignore */ }
  }

  links.sort((a, b) => b.score - a.score)
  // Deduplicate by URL (same contact page often linked from nav + footer — keep highest score)
  // Normalize: strip trailing slash AND collapse http/https + www variants so
  // "https://www.example.com/contact" and "http://example.com/contact" are treated as the same page.
  const _seenLinkUrls = new Set<string>()
  const uniqueLinks = links.filter((l) => {
    // Dedup key: normalize scheme, www-prefix, trailing slash, and strip known tracking params
    // so nav-link and footer-link pointing to the same contact page are correctly identified as one.
    let k: string
    try {
      const u = new URL(l.url)
      // Remove tracking parameters that don't affect page content
      const TRACKING_PARAMS = ['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid','msclkid','ref','from']
      TRACKING_PARAMS.forEach((p) => u.searchParams.delete(p))
      k = (u.origin + u.pathname.replace(/\/$/, '') + u.search).toLowerCase().replace(/^https?:\/\/(www\.)?/, '')
    } catch {
      k = l.url.toLowerCase().replace(/\/$/, '').replace(/^https?:\/\/(www\.)?/, '')
    }
    if (_seenLinkUrls.has(k)) return false
    _seenLinkUrls.add(k)
    return true
  })

  // ── JSON-LD extraction (highest priority — structured, authoritative) ──────────
  // Many modern Japanese sites expose email, telephone, and address in @type Organization/LocalBusiness.
  let jsonLdEmail: string | null = null
  let jsonLdPhone: string | null = null
  let jsonLdAddress: string | null = null
  const jsonLdRe = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let jldMatch: RegExpExecArray | null
  while ((jldMatch = jsonLdRe.exec(html)) !== null) {
    try {
      const obj = JSON.parse(jldMatch[1])
      const entries = Array.isArray(obj) ? obj : [obj]
      for (const entry of entries) {
        if (!jsonLdEmail && entry.email && typeof entry.email === 'string') jsonLdEmail = entry.email
        if (!jsonLdPhone && entry.telephone && typeof entry.telephone === 'string') jsonLdPhone = entry.telephone
        // Address: can be a string or a PostalAddress object
        if (!jsonLdAddress && entry.address) {
          if (typeof entry.address === 'string') {
            jsonLdAddress = entry.address
          } else if (typeof entry.address === 'object') {
            const a = entry.address
            // Build Japanese-style address: 〒postal prefecture city streetAddress
            const parts = [
              a.postalCode ? `〒${a.postalCode.replace(/^〒/, '')}` : '',
              a.addressRegion || '',
              a.addressLocality || '',
              a.streetAddress || '',
            ].filter(Boolean)
            if (parts.length > 0) jsonLdAddress = parts.join(' ')
          }
        }
        // Also check nested contactPoint
        const cp = entry.contactPoint
        if (cp) {
          const cps = Array.isArray(cp) ? cp : [cp]
          for (const c of cps) {
            if (!jsonLdEmail && c.email) jsonLdEmail = c.email
            if (!jsonLdPhone && c.telephone) jsonLdPhone = c.telephone
          }
        }
        if (jsonLdEmail && jsonLdPhone && jsonLdAddress) break
      }
    } catch { /* malformed JSON-LD — skip */ }
    if (jsonLdEmail && jsonLdPhone && jsonLdAddress) break
  }

  // ── Schema.org microdata extraction (itemprop) — fallback after JSON-LD ─────
  // Many Japanese sites embed microdata inline rather than JSON-LD.
  // Only used if JSON-LD did not provide the value.
  if (!jsonLdPhone) {
    const itempropPhone = html.match(/itemprop=["']telephone["'][^>]*>([^<]+)</i)
      || html.match(/>([^<]+)<[^>]+itemprop=["']telephone["']/i)
    if (itempropPhone?.[1]) {
      const raw = itempropPhone[1].replace(/<[^>]+>/g, '').trim()
      const digits = raw.replace(/[^\d]/g, '')
      if (digits.length >= 10 && digits.length <= 11 && digits.startsWith('0')) {
        jsonLdPhone = raw
      }
    }
  }
  if (!jsonLdAddress) {
    // Attempt flat itemprop="address" first (simplest case)
    const itempropAddr = html.match(/itemprop=["']address["'][^>]*>([^<]{5,120})</i)
    if (itempropAddr?.[1]) {
      jsonLdAddress = itempropAddr[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    } else {
      // PostalAddress microdata: assemble from itemprop parts
      const region   = html.match(/itemprop=["']addressRegion["'][^>]*>([^<]+)</i)?.[1]?.trim()
      const locality = html.match(/itemprop=["']addressLocality["'][^>]*>([^<]+)</i)?.[1]?.trim()
      const street   = html.match(/itemprop=["']streetAddress["'][^>]*>([^<]+)</i)?.[1]?.trim()
      const postal   = html.match(/itemprop=["']postalCode["'][^>]*>([^<]+)</i)?.[1]?.trim()
      const parts = [
        postal ? `〒${postal.replace(/^〒/, '')}` : '',
        region || '',
        locality || '',
        street || '',
      ].filter(Boolean)
      if (parts.length >= 2) jsonLdAddress = parts.join(' ')
    }
  }
  // Plain-text Japanese address fallback: 〒[postal] + prefecture + [city...].
  // Only used when structured-data extraction found nothing.
  if (!jsonLdAddress) {
    // Normalize <br> variants to spaces so the regex can span line-break-separated addresses.
    const htmlBrNorm = html.replace(/<br\s*\/?>/gi, ' ').replace(/\n+/g, ' ')
    // Pattern 1: 〒NNN-NNNN followed by characters that include a prefecture keyword
    const postalAddrM = htmlBrNorm.match(/〒\s*(\d{3}[－\-]\d{4}|\d{7})\s*([^<]{5,80}(?:都|道|府|県)[^<]{0,60})/u)
    if (postalAddrM) {
      const postalCode = postalAddrM[1].replace(/[－]/g, '-')
      const addrRest = postalAddrM[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      jsonLdAddress = `〒${postalCode} ${addrRest}`.slice(0, 100)
    } else {
      // Pattern 2: address label "所在地：" / "住所：" followed by Japanese address text
      const addrLabelM = htmlBrNorm.match(/(?:所在地|住所|本社所在地|事務所|拠点|所在地・アクセス|address)[\s\u3000]*[：:]\s*([^<]{8,100}(?:都|道|府|県)[^<]{0,60})/iu)
      if (addrLabelM) {
        jsonLdAddress = addrLabelM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 100)
      } else {
        // Pattern 3: standalone prefecture + city (no postal code or label) — weakest signal
        // Only use when text clearly starts with a Japanese prefecture name (for precise matches)
        const prefM = htmlBrNorm.match(/(?:^|>|\s)((?:北海道|東京都|大阪府|京都府|(?:青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄)県)[^<]{5,60}(?:市|区|町|村|丁目|番地|番|号)[^<]{0,40})/u)
        if (prefM?.[1]) {
          jsonLdAddress = prefM[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 100)
        }
      }
    }
  }

  // Prioritized email extraction:
  // 1. JSON-LD (authoritative)
  // 2. mailto: links with "contact-friendly" local parts (info, contact, inquiry, etc.)
  // 3. Any mailto: link
  // 4. Plain-text email address
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]{3,}@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,6}/g
  const CONTACT_LOCAL = /^(info|contact|inquiry|enquiry|otoiawase|toiawase|ask|support|mail|office|reception|hellocontact|hello|general|service|help|webmaster|admin|postmaster|reach|connect|sales|cs|pr|hr)([._+-]|$)/i
  const allMailtos: string[] = [...html.matchAll(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi)].map(m => m[1])
  const contactMailto = allMailtos.find((e) => CONTACT_LOCAL.test(e.split('@')[0])) || allMailtos[0] || null

  // Fallback email from page text: strip tags first to avoid matching `class="foo@bar"` style attributes
  const plainText = html.replace(/<[^>]+>/g, ' ')
  const plainEmails: string[] = [...plainText.matchAll(new RegExp(EMAIL_RE.source, 'g'))].map(m => m[0])
  const filteredPlainEmails = plainEmails.filter((e) => !e.endsWith('.js') && !e.endsWith('.css') && !e.endsWith('.png') && !e.endsWith('.jpg'))
  const contactPlainEmail = filteredPlainEmails.find((e) => CONTACT_LOCAL.test(e.split('@')[0])) || filteredPlainEmails[0] || null

  // Obfuscated email fallback: many Japanese sites write "info[at]example.co.jp" or "info（at）example.co.jp"
  // to avoid spam bots. Normalize and extract these.
  let obfuscatedEmail: string | null = null
  if (!contactMailto && !contactPlainEmail) {
    const obfM = plainText.match(/([a-zA-Z0-9._%+\-]{2,})[\s]*(?:\[at\]|\(at\)|【at】|＠|\s+at\s+|@)\s*([a-zA-Z0-9.\-]{2,}\.[a-zA-Z]{2,6})/i)
    if (obfM) {
      const candidate = `${obfM[1]}@${obfM[2]}`.replace(/\s+/g, '')
      // Basic sanity check: not ending in asset extensions
      if (!candidate.endsWith('.js') && !candidate.endsWith('.css') && !candidate.endsWith('.png')) {
        obfuscatedEmail = candidate
      }
    }
  }

  const email = jsonLdEmail || contactMailto || contactPlainEmail || obfuscatedEmail

  // Phone extraction: tel: link is most reliable.
  // Fallback patterns handle:
  //   - Hyphens/dashes:  03-1234-5678  or  03－1234－5678  or  ０３－１２３４－５６７８
  //   - Brackets:        03(1234)5678  or  03（1234）5678
  //   - Compact:         0312345678  (10-11 digits with leading 0)
  //   - Country code:    +81-3-1234-5678
  // Normalize full-width digits and separators to half-width for matching.
  // Also convert full-width parentheses and hyphens so the phone regex can match them.
  const htmlForPhone = html
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[（]/g, '(').replace(/[）]/g, ')').replace(/[－]/g, '-')
  const PHONE_RE_HYPHEN  = /(0\d{1,4}[-\-–—(]\d{1,4}[)–—\-]\d{3,4})/
  const PHONE_RE_COMPACT = /(0[0-9]{9,10})/
  const PHONE_RE_INTL    = /(\+81[-\s\d]{8,16})/
  // Pre-compute FAX numbers so we can skip them when picking the phone number.
  // FAX-labeled numbers use the same digit patterns as phone numbers.
  const faxNums = new Set<string>()
  const FAX_RE = /(?:fax|ファックス|ファクシミリ|FAX|F\.?)[\s\u3000:：\-\.]*(0\d{1,4}[-\-–—(]\d{1,4}[)–—\-]\d{3,4}|0[0-9]{9,10})/gi
  let faxM: RegExpExecArray | null
  while ((faxM = FAX_RE.exec(htmlForPhone)) !== null) {
    faxNums.add((faxM[1] || '').replace(/[^\d]/g, ''))
  }
  const isNotFax = (digits: string) => !faxNums.has(digits)

  const phoneM = !jsonLdPhone ? (
    // Priority 1: tel: link (most authoritative)
    htmlForPhone.match(/tel:([\d\-+\s()]{7,20})/i) ||
    // Priority 2: number immediately after TEL/電話 label (avoids grabbing fax numbers)
    htmlForPhone.match(/(?:tel|電話|お電話|TEL)[\s\u3000:：\-\.]*(0\d{1,4}[-\-–—(]\d{1,4}[)–—\-]\d{3,4})/i) ||
    htmlForPhone.match(/(?:tel|電話|お電話|TEL)[\s\u3000:：\-\.]*(0[0-9]{9,10})/i) ||
    // Priority 3: generic hyphen/bracket pattern (might be fax — checked below)
    htmlForPhone.match(PHONE_RE_HYPHEN) ||
    htmlForPhone.match(PHONE_RE_COMPACT) ||
    htmlForPhone.match(PHONE_RE_INTL)
  ) : null
  let phone: string | null = null
  if (jsonLdPhone) {
    // JSON-LD telephone: normalize to standard format
    const normalized = jsonLdPhone.replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/[－–—]/g, '-').replace(/\s+/g, '').trim()
    const digits = normalized.replace(/[^\d]/g, '')
    if ((digits.length >= 10 && digits.length <= 11 && digits.startsWith('0')) || normalized.startsWith('+81')) {
      phone = normalized
    }
  }
  if (!phone) {
    const rawPhone = phoneM ? (phoneM[1] || '').replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/[－–—]/g, '-').replace(/\s+/g, '').trim() : null
    const phoneDigits = rawPhone ? rawPhone.replace(/[^\d]/g, '') : ''
    if (rawPhone && (
      (phoneDigits.length >= 10 && phoneDigits.length <= 11 && phoneDigits.startsWith('0') && isNotFax(phoneDigits)) ||
      rawPhone.startsWith('+81')
    )) {
      phone = rawPhone
    }
  }

  let hasContactLink = uniqueLinks.length > 0
  let formUrl: string | null = uniqueLinks.length > 0 ? uniqueLinks[0].url : null

  if (!hasContactLink && hasInlineForm) {
    formUrl = baseUrl
    hasContactLink = true
  }

  // Detect external form services via <form action="..."> or <iframe src="...">
  // These patterns catch embedded third-party forms that aren't linked via <a> tags
  if (!hasContactLink) {
    const FORM_ACTION_RE = /<form[^>]+action=["']([^"']+)["']/gi
    let faMatch: RegExpExecArray | null
    while ((faMatch = FORM_ACTION_RE.exec(html)) !== null) {
      try {
        const actionUrl = new URL(faMatch[1], effectiveBase)
        const actionHost = actionUrl.hostname.replace(/^www\./, '')
        if (EXTERNAL_FORM_HOSTS.some((h) => actionHost.includes(h))) {
          formUrl = actionUrl.toString()
          hasContactLink = true
          break
        }
      } catch { /* ignore */ }
    }
  }
  if (!hasContactLink) {
    const IFRAME_SRC_RE = /<iframe[^>]+src=["']([^"']+)["']/gi
    let ifMatch: RegExpExecArray | null
    while ((ifMatch = IFRAME_SRC_RE.exec(html)) !== null) {
      try {
        const iframeUrl = new URL(ifMatch[1], effectiveBase)
        const iframeHost = iframeUrl.hostname.replace(/^www\./, '')
        if (EXTERNAL_FORM_HOSTS.some((h) => iframeHost.includes(h))) {
          formUrl = iframeUrl.toString()
          hasContactLink = true
          break
        }
      } catch { /* ignore */ }
    }
  }
  // Detect embedded form services loaded via <script src="...">
  // (e.g., form.run, Tayori, Microsoft Forms, HubSpot, etc.).
  // When found, the current page IS the contact form URL.
  if (!hasContactLink) {
    const SCRIPT_SRC_RE = /<script[^>]+src=["']([^"']+)["']/gi
    let scMatch: RegExpExecArray | null
    while ((scMatch = SCRIPT_SRC_RE.exec(html)) !== null) {
      try {
        const scriptHost = new URL(scMatch[1], effectiveBase).hostname.replace(/^www\./, '')
        if (EXTERNAL_FORM_HOSTS.some((h) => scriptHost.includes(h))) {
          // The form is embedded on this page — the page itself is the contact URL
          formUrl = baseUrl
          hasContactLink = true
          break
        }
      } catch { /* ignore */ }
    }
  }
  // Detect inline JavaScript form initialization patterns:
  // HubSpot hbspt.forms.create(), Zendesk zE(), Intercom window.intercomSettings, etc.
  // These widgets render contact forms entirely in JS — no <form> tags in static HTML.
  if (!hasContactLink && INLINE_FORM_JS_RE.test(html)) {
    formUrl = baseUrl
    hasContactLink = true
  }

  const hasEmailContact = !!email
  // NOTE: email-only sites are NOT counted as having a contact form.
  // Email is stored for reference but formUrl must point to an actual web form.

  // Determine formTypeHint from detected links and page content
  const lHtml = html.toLowerCase()
  let formTypeHint: 'inquiry' | 'booking' | 'LINE' | null = null
  if (formUrl && LINE_HINT_PATTERNS.some((re) => re.test(formUrl!))) {
    formTypeHint = 'LINE'
  } else if (formUrl && (() => { try { const h = new URL(formUrl).hostname.replace(/^www\./, ''); return BOOKING_URL_HOSTS.some((bh) => h.includes(bh)) } catch { return false } })()) {
    // formUrl points to a known booking service → always 'booking'
    formTypeHint = 'booking'
  } else if (BOOKING_KW.some((kw) => lHtml.includes(kw.toLowerCase())) && !hasInlineForm) {
    formTypeHint = 'booking'
  } else if (hasContactLink || hasInlineForm) {
    formTypeHint = 'inquiry'
  }

  return { formUrl, email, phone, address: jsonLdAddress, hasContactLink, hasInlineForm, hasEmailContact, formTypeHint, contactLinks: uniqueLinks.slice(0, 3) }
}

/**
 * Check a single form's context window for inquiry signals.
 * Called once per <form> block found on the page.
 *
 * @param formCtx  HTML slice: 800 chars before <form ...> + 5000 chars after
 */
function _validateFormContext(formCtx: string): boolean {
  // Reject forms that only contain hidden/checkbox inputs (social share, CSRF-only)
  const hasUserInput = /<input[^>]+type=["']?(text|email|tel|number|search|url)/i.test(formCtx)
    || /textarea/i.test(formCtx)
  if (!hasUserInput) return false

  // Reject login / registration forms — contact forms never have password fields
  if (/type=["']?password/i.test(formCtx)) return false

  // Reject purchase / checkout forms — contact forms don't have cart, quantity, or payment context
  if (/数量|カート|ショッピング|購入する|ご購入|注文内容|決済|クレジットカード|お支払い方法|配送先住所/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false

  // Reject job application / recruitment forms — career pages have "職種", "志望動機", "履歴書", etc.
  if (/志望動機|職種|採用.*フォーム|application form|job application|apply for|応募フォーム|履歴書/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false

  // Reject WordPress / blog CMS comment forms.
  // These have textarea + name/email but are comment sections, not inquiry forms.
  if (/(?:class|id)=["'][^"']*(?:comment[-_]?form|wp-comment|respond|leave[-_]?a[-_]?reply)[^"']*["']/i.test(formCtx)) return false
  // Also reject if the form/surrounding context talks about comments, not inquiries
  const lCtx = formCtx.toLowerCase()
  if (/コメント|comment|leave a reply|返信する|reply to/.test(lCtx) && !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(lCtx)) return false
  // Reject newsletter / email subscription forms (email + submit only, "subscribe" keywords)
  if (/subscribe|newsletter|メルマガ|メールマガジン|登録する|email.*sign.?up|sign.?up.*email|配信登録|お知らせ登録/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject event / seminar registration forms — attendance registrations are not inquiry forms
  if (/イベント.*(?:申し込み|参加登録|お申し込み|登録フォーム)|セミナー.*(?:申し込み|参加登録|お申し込み|登録フォーム)|説明会.*(?:申し込み|参加登録)|勉強会.*(?:申し込み|参加登録)|event.*(?:registration|signup|sign.?up|apply)|seminar.*(?:registration|apply)|webinar.*(?:register|registration)/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject survey / questionnaire forms — not contact forms
  if (/アンケート|survey|questionnaire|アンケートフォーム|ご意見募集|意見収集/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject user / membership account registration forms — these are login signups, not contact forms
  if (/会員登録|新規登録|アカウント作成|ユーザー登録|membership.*(?:register|sign.?up)|create.*account|register.*account|sign.?up.*account/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject document / material download lead-gen forms (B2B gated content).
  // These capture email in exchange for a PDF/whitepaper — not inquiry forms.
  if (/資料ダウンロード|ホワイトペーパー.*ダウンロード|事例集.*ダウンロード|whitepaper.*download|ebook.*download|download.*(?:pdf|resource|guide|report)|無料ダウンロード|カタログ.*ダウンロード/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject review / testimonial submission forms — not inquiry forms
  if (/(?:レビュー|口コミ|お客様の声).*(?:投稿|フォーム|を書く|を入力)|(?:review|testimonial).*(?:form|submit|write|leave)|rate.*(?:us|this)|rating.*form/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject free trial / account trial signup forms (SaaS-style CTAs)
  if (/無料トライアル|free.*trial.*(?:form|sign.?up|start)|trial.*(?:register|signup|start)|(?:start|begin).*free.*trial|お試し登録|体験版.*申し込み/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject event/seminar capacity-limited registration forms.
  // Forms showing seat availability ("残席3席", "定員に達し次第") combined with
  // application language are attendance registrations, not inquiry forms.
  if (/定員(?:に達し|超過|オーバー|まで|[0-9])|残席[^。]{0,20}[0-9]|残り[^。]{0,10}席|満席|キャンセル待ち|お席の確保|席数限定/i.test(formCtx) &&
      /(?:参加|出席|申込|お申込)(?:フォーム|登録|申し込み|する)|参加者(?:情報|氏名|名前)/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject donation / fundraising forms — charity contribution pages, not inquiry forms
  if (/寄付(?:フォーム|をする|する|のお申し込み|金額|額)|ご寄付(?:のお申し込み|をいただく|をお願い)|donate(?:\s*now)?|donation(?:\s*form)?|fundrais(?:ing|e)|支援金|クラウドファンディング.*(?:支援|寄付)|ご支援をお願い/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject medical appointment / clinic reservation forms — 診察予約 is not a contact inquiry form
  if (/診察予約|診療予約|ご予約フォーム.*(?:受診|来院|初診|外来|クリニック)|初診(?:予約|申し込み)|来院(?:予約|申し込み)|web予約システム|ネット受付|オンライン診療予約/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject contest / campaign entry forms — these are prize-entry or sweepstakes forms
  if (/キャンペーン(?:への)?応募|懸賞(?:に)?応募|プレゼント(?:に)?応募|抽選(?:に)?応募|contest.*entry|sweepstake|campaign.*entry|応募(?:フォーム|する|してください)|当選者/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false
  // Reject petition / signature collection forms — not inquiry forms
  if (/署名(?:フォーム|活動|運動|を集め|にご協力)|petition|ご署名|署名する|賛同者/i.test(formCtx) &&
      !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false

  // ── Textarea path ───────────────────────────────────────────────
  // The 800-char pre-window often contains headings like "お問い合わせ"
  // right above the form — strong signal for contact forms.
  if (/textarea/i.test(formCtx)) {
    // Reject reservation forms: has strong booking signal but no inquiry keywords.
    // This prevents beauty-salon reservation embeds (with name/email/textarea for "special requests")
    // from being misclassified as contact forms.
    if (/予約フォーム|ご予約フォーム|ネット予約|来店予約|席の予約|席予約|テーブル予約|完全予約制|ご予約日時|希望日時|reservation form|booking form|book now|book a (?:table|seat|room|visit|appointment)/i.test(formCtx) &&
        !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(formCtx)) return false

    const INQUIRY_KW = /お問い合わせ|ご連絡|ご相談|お問合|inquiry|contact us|contact form|ご質問|お問い合わせ内容|お問合せ内容|メッセージ内容|ご意見/i
    // Only auto-accept on inquiry keyword when it appears INSIDE the form (after <form tag)
    // or in the tight pre-window (label/heading immediately preceding the form, not from a nav link far away).
    // This prevents a nav "お問い合わせ" link 700+ chars before a reservation form from triggering a false positive.
    const formStartIdx = formCtx.toLowerCase().indexOf('<form')
    const insideForm = formStartIdx !== -1 ? formCtx.slice(formStartIdx) : formCtx
    if (INQUIRY_KW.test(insideForm)) return true
    // Also accept if the keyword appears within the tight 200-char pre-window (heading directly above form)
    const tightPreWindow = formStartIdx > 0 ? formCtx.slice(Math.max(0, formStartIdx - 200), formStartIdx) : ''
    if (tightPreWindow && INQUIRY_KW.test(tightPreWindow)) return true
    const hasNameField = /<input[^>]+(name|id)=["']?(?:name|your[_-]?name|お名前|namae)/i.test(formCtx)
    const hasEmailField = /<input[^>]+type=["']?email/i.test(formCtx)
    if (hasNameField && hasEmailField) return true
    const hasTextInput = /<input[^>]+type=["']?text/i.test(formCtx)
    // Submit detection: type="submit", type="image" (image button), or <button> without type (defaults to submit)
    const hasSubmitFallback = /<(input|button)[^>]*type=["']?submit/i.test(formCtx)
      || /<input[^>]+type=["']?image/i.test(formCtx)
      || /<button(?![^>]*type=["']?(?:button|reset)["'])[^>]*>/i.test(formCtx)
    if (hasTextInput && hasEmailField && hasSubmitFallback) return true
    // Relaxed: textarea + submit + 2+ text inputs + email-like field name
    // (Handles old Japanese sites where email uses type="text" instead of type="email")
    // Requiring an email-like field prevents reservation forms from matching.
    const hasEmailLikeField = /<input[^>]+(name|id)=["']?(?:e-?mail|mail|メール|your.?mail|your.?email|yourmail)/i.test(formCtx)
    const textInputCount = (formCtx.match(/<input[^>]+type=["']?text/gi) || []).length
    if (hasSubmitFallback && textInputCount >= 2 && hasEmailLikeField) return true

    // Phone-only contact: name + tel input + textarea (common in beauty/medical/dental)
    // Require name field to distinguish from general feedback/survey forms.
    const hasTelInput = /<input[^>]+type=["']?tel/i.test(formCtx)
    if (hasSubmitFallback && hasTelInput && hasNameField) return true
  }

  // ── Email/tel + submit path ─────────────────────────────────────
  // For forms without textarea, require the inquiry keyword to appear INSIDE
  // the form (after the opening <form> tag), NOT just in the pre-window.
  // This prevents newsletter signups whose pre-window includes a nav "お問い合わせ" link.
  const hasContactInput = /<input[^>]+type=["']?(email|tel)/i.test(formCtx)
  const hasSubmit = /<(input|button)[^>]*type=["']?submit/i.test(formCtx)
  if (hasContactInput && hasSubmit) {
    const formTagIdx = formCtx.toLowerCase().indexOf('<form')
    const insideFormCtx = formTagIdx !== -1 ? formCtx.slice(formTagIdx) : formCtx
    const FORM_KW = /お問い合わせ|ご連絡|ご相談|お問合|inquiry|contact us|contact form|ご質問|お問い合わせ内容|ご相談フォーム/i
    if (FORM_KW.test(insideFormCtx)) return true
  }

  return false
}

/**
 * Verify that a fetched HTML page actually contains a contact / inquiry form.
 * Rejects login pages, search boxes, newsletter signups, blog comments, thank-you pages, etc.
 *
 * Design goals:
 *  - High precision over recall: when in doubt, reject.  GPT does the final call.
 *  - Scans ALL <form> blocks on the page — pages often have a search box first, then
 *    the actual contact form; only checking the first form misses this pattern.
 *  - Textarea + specific Japanese/English inquiry keyword → accept.
 *  - Email/tel input + submit → only accept when keyword appears IN the form context.
 */
// Inline JS form widget patterns — same set as in extractForms for consistency
const INLINE_FORM_JS_RE = /hbspt\.forms\.create\s*\(|window\.intercomSettings\s*=|zE\s*\(\s*['"]webWidget|Freshdesk\s*\.|tayori(?:\.com)?.*init|kintoneapp.*(?:form|init)|wpcf7.*(?:init|ajaxurl|\.js)|contact-form-7['"\/]|elfsight-app.*contact|eapps-form-builder|n-form\.jp\/form|webto\.salesforce\.com|app\.zendesk\.com\/hc.*contact|crisp\.chat|LiveChatInc|tawk\.to/i

function validateFormPage(html: string): boolean {
  // External form embeds always accepted — checks both fast-path (Google Forms, etc.) and
  // additional known form SaaS services that may appear in iframe src or form action attributes.
  if (EXTERNAL_FORM_FAST_PASS_RE.test(html)) return true
  // LINE contact links — always valid contact method
  if (LINE_CONTACT_RE.test(html)) return true
  // schema.org ContactPage microdata: the page explicitly declares itself as a contact page
  if (/itemtype=["'][^"']*schema\.org\/ContactPage["']/i.test(html)) return true
  // schema.org JSON-LD "@type": "ContactPage" — JSON-LD alternative to microdata
  if (/"@type"\s*:\s*"ContactPage"/i.test(html)) return true
  // Inline JS form widgets (HubSpot, Intercom, Zendesk, etc.) — valid contact form
  if (INLINE_FORM_JS_RE.test(html)) return true

  // Reject confirmed thank-you / completion pages (no form present)
  const title = extractTitle(html).toLowerCase()
  if (/送信完了|ありがとうございます|受け付けました|thank you|submission complete|success/.test(title)) {
    if (!/<form[\s>]/i.test(html)) return false
  }
  // Reject pages whose title strongly suggests non-contact content and have no form
  if (/ニュース|news|プレスリリース|お知らせ一覧|アクセス|access|採用|recruit|サービス一覧|実績|ブログ|blog|プライバシー|privacy|利用規約|terms|サイトマップ|sitemap|会社概要|ギャラリー|gallery|イベント一覧|セミナー一覧|webinar|workshop|会員登録|メンバー登録|資料ダウンロード|ホワイトペーパー|whitepaper|free.*download|無料ダウンロード/.test(title)) {
    if (!/<form[\s>]/i.test(html)) return false
  }
  // Reject non-contact page types via OGP og:type (articles, products, etc. rarely have contact forms)
  const ogType = (
    html.match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:type["']/i)?.[1]
  )?.toLowerCase()
  if (ogType && /^(article|news|blog|product|video\.other|music\.song)$/.test(ogType)) {
    if (!/<form[\s>]/i.test(html)) return false
  }

  if (!/<form[\s>]/i.test(html)) return false

  // Title-based fast-accept: when the page title unambiguously says "contact/inquiry",
  // skip the heavy per-form analysis — it's almost certainly a contact page.
  // Matches both "お問い合わせ | 会社名" (prefix) and "会社名 | お問い合わせ" (suffix) patterns.
  // Also accepts compound titles like "ご連絡フォーム", "ご相談フォーム", "お問い合わせ窓口".
  const CONTACT_TITLE_KW = /お問い合わせ(?:フォーム|窓口|ページ)?|ご相談(?:フォーム)?|ご連絡(?:フォーム)?|お問合せ(?:フォーム)?|お問合わせ(?:フォーム)?|メールフォーム|問い合わせフォーム|ご相談・お問い合わせ|お問い合わせ・ご相談|お問い合わせ・ご連絡|otoiawase|toiawase|contact|inquiry|contact.?us|contact.?form|inquiry.?form|get.?in.?touch|send.?message/i
  if (
    new RegExp('^(' + CONTACT_TITLE_KW.source + ')(\\s*[|｜\\-–—\\/・]|\\s*$)', 'i').test(title) ||
    // Keyword at the END of title after a separator or space: "会社名 | お問い合わせ" or "会社名 お問い合わせ"
    new RegExp('[|｜\\-–—\\/・\\s]\\s*(' + CONTACT_TITLE_KW.source + ')\\s*$', 'i').test(title)
  ) {
    return true
  }

  // ── Scan every <form> on the page ───────────────────────────────
  // Many pages have a header search box (or newsletter signup) before the actual contact form.
  // By iterating all forms we avoid missing the real inquiry form.
  const lHtml = html.toLowerCase()
  let pos = -1
  while ((pos = lHtml.indexOf('<form', pos + 1)) !== -1) {
    // Window: 800 chars before (headings/breadcrumbs) + 5000 after (labels + fields)
    const formCtx = html.slice(Math.max(0, pos - 800), Math.min(html.length, pos + 5000))
    if (_validateFormContext(formCtx)) return true
  }

  return false
}

/**
 * Common contact page paths to probe when no form link is found via link extraction.
 * Ordered by likelihood. We try at most PROBE_LIMIT paths to keep latency bounded.
 */
const PROBE_PATHS = [
  // English / romaji — most common even on Japanese sites
  '/contact', '/inquiry', '/contact/', '/inquiry/',
  // Japanese romaji variants
  '/otoiawase', '/toiawase', '/otoiawase/', '/toiawase/',
  '/mailform', '/mailform/', '/form', '/renraku', '/goiken',
  // URL-encoded Japanese paths — placed early so they're always probed within the limit.
  // These cover pure-Japanese-URL sites (Jimdo, some no-code builders) where even /contact doesn't exist.
  '/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B',  // /お問い合わせ
  '/%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B',            // /問い合わせ
  '/%E3%81%8A%E5%95%8F%E5%90%88%E3%81%9B',                     // /お問合せ
  '/%E3%81%94%E7%9B%B8%E8%AB%87',                              // /ご相談
  '/%E3%81%94%E9%80%A3%E7%B5%A1',                              // /ご連絡
  // Japanese compound variants common on SMB sites
  '/otoiawase-form', '/toiawase-form',
  '/form/otoiawase', '/form/toiawase',
  // With common extensions
  '/contact.html', '/inquiry.html', '/contact.php', '/inquiry.php',
  '/contact/index.html', '/inquiry/index.html',
  '/contact/index.php',  '/inquiry/index.php',
  '/mailform/index.html', '/mailform/index.php',
  // PHP form handlers common on Japanese rental hosting
  '/mail.php', '/send.php', '/post.php', '/form.html', '/form.php',
  // CGI patterns common on Japanese hosting (rental servers: lolipop, xserver, sakura)
  '/cgi-bin/contact.cgi', '/cgi-bin/inquiry.cgi', '/cgi-bin/form.cgi',
  '/cgi-bin/mailform.cgi', '/cgi-bin/contact.pl', '/cgi-bin/form.pl',
  '/cgi-bin/mail.cgi', '/cgi-bin/post.cgi',
  // WordPress / common CMS slugs
  '/contact-us', '/contact-us/', '/contact_us', '/contactus', '/get-in-touch', '/send-message',
  '/contact-form', '/contact-form/',
  '/inquiry-form', '/inquiry_form', '/contactform',
  '/message', '/message/', '/ask', '/consultation', '/consultation/',
  '/free-consultation', '/free-consultation/',
  // Japanese romaji: soudan (相談), meiru (メール), renraku (連絡)
  '/soudan', '/soudan/', '/meiru', '/meiru/',
  // Shopify / Square Online: pages are nested under /pages/
  '/pages/contact', '/pages/inquiry', '/pages/contact-us',
  '/pages/message', '/pages/form', '/pages/mailform',
  // Additional CGI patterns common on old Japanese hosting
  '/cgi-bin/toiawase.cgi', '/cgi-bin/otoiawase.cgi',
  '/cgi-bin/contactus.cgi', '/cgi-bin/mailsend.cgi',
  '/cgi/contact.cgi', '/cgi/inquiry.cgi',
  // Common Japanese HP builder slug patterns (Jimdo, STORES, BASE)
  '/contact-page', '/inquiry-page',
  // Wix / Squarespace
  '/contact-1', '/contact-2',
  // ASP / ASPX (old Windows hosting common in Japan)
  '/contact.asp', '/inquiry.asp', '/contact.aspx', '/inquiry.aspx',
  '/form.asp', '/form.aspx', '/mail.asp', '/mail.aspx',
  // Additional Japanese romaji variants
  '/otoiawase.html', '/toiawase.html', '/otoiawase.php', '/toiawase.php',
  // Generic "email" / "write" pages used on smaller sites
  '/email', '/write', '/reach-us', '/reach',
  // Additional Japanese CMS patterns
  '/contact/form', '/inquiry/form', '/form/contact', '/form/inquiry',
  '/support/contact', '/support/inquiry', '/help/contact',
  // Common on dental / medical / beauty clinic sites
  '/online-inquiry', '/online-contact', '/web-inquiry', '/web-contact',
  '/online_inquiry', '/online_contact', '/web_inquiry', '/web_contact',
  // Locale-prefixed paths: bilingual Japanese corporate sites (/ja/, /jp/, /en/)
  '/ja/contact', '/ja/inquiry', '/jp/contact', '/jp/inquiry',
  '/en/contact', '/en/inquiry',
  // .html variants for Japanese HTML-heavy CMS
  '/renraku.html', '/goiken.html',
]
const PROBE_LIMIT = 28  // covers URL-encoded Japanese paths, compound otoiawase-form variants, locale-prefixed paths

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
      formUrl: null, email: null, phone: null, address: null,
      hasContactLink: false, hasInlineForm: false, hasEmailContact: false,
      formTypeHint: null, contactLinks: [], formPageText: null, formPageTitle: null,
      error: hpFetch.error,
    }
  }

  // Step 2: extract form links
  // Use finalUrl as the base for link resolution — handles http→https redirects and
  // domain migrations so relative links like /contact resolve to the correct origin.
  let effectiveBase = (hpFetch.finalUrl && hpFetch.finalUrl !== url) ? hpFetch.finalUrl : baseUrl

  // Canonical URL refinement: <link rel="canonical" href="..."> can reveal the true
  // base URL on sites with trailing-slash normalization or locale path prefixes (/en/).
  // Only apply when the canonical is on the same origin (avoid CDN/proxy edge-case).
  const canonicalM = hpFetch.html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || hpFetch.html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)
  if (canonicalM) {
    try {
      const canonicalUrl = new URL(canonicalM[1], effectiveBase)
      const canonicalOrigin = canonicalUrl.origin
      const effectiveOrigin = new URL(effectiveBase).origin
      // Only use canonical if same origin — avoids picking up CDN mirror URLs
      if (canonicalOrigin === effectiveOrigin) {
        effectiveBase = canonicalUrl.toString()
      }
    } catch { /* ignore malformed canonical */ }
  }

  // Detect JavaScript-rendered SPA: Next.js, Nuxt.js, React apps, Gatsby, Remix, Astro, etc.
  // Contact pages on SPA sites return a JS shell — `validateFormPage` would fail because
  // the form is rendered by JS after load.  We use the HP-level contact link URL directly
  // if the URL strongly implies it's a contact page (URL_SEGMENT_RE match).
  const isSpa = /__NEXT_DATA__|__NUXT__|_nuxt\/|window\.__INITIAL_STATE__|<div id="app"><\/div>|<div id="__next"><\/div>|window\.__gatsby|___gatsby|<div id="gatsby-focus-wrapper"|remixContext|window\.__remixContext|<astro-island|ng-version=|<app-root[\s>]|window\.angular|data-page=["']\{.*"component"/.test(hpFetch.html)

  // Step 3: fetch form page and validate it actually contains a contact form
  let formPageText: string | null = null
  let formPageTitle: string | null = null

  // Early reject: if the HP URL itself redirected to a booking/SNS service,
  // the company has no independent website — skip all processing.
  if (hpFetch.finalUrl && hpFetch.finalUrl !== url) {
    try {
      const hpFinalHost = new URL(hpFetch.finalUrl).hostname.replace(/^www\./, '')
      if (REDIRECT_REJECT_HOSTS.some((h) => hpFinalHost === h || hpFinalHost.endsWith('.' + h))) {
        return {
          url, baseUrl, formUrl: null, email: null, phone: null, address: null,
          hasContactLink: false, hasInlineForm: false, hasEmailContact: false,
          formTypeHint: null, contactLinks: [], formPageText: null, formPageTitle: null, error: null,
        }
      }
    } catch { /* ignore */ }
  }

  const extracted = extractForms(hpFetch.html, effectiveBase)

  const tryFetchAndValidate = async (targetUrl: string, cachedHtml: string | null): Promise<{ html: string; valid: boolean; finalUrl?: string } | null> => {
    try {
      // Fast-pass: known external form service URL — no network fetch required.
      // These services are always valid contact forms and often render via JavaScript
      // so fetching would return empty or partially-rendered HTML.
      if (cachedHtml === null) {
        try {
          const targetHost = new URL(targetUrl).hostname.replace(/^www\./, '')
          if (EXTERNAL_FORM_HOSTS.some((h) => targetHost === h || targetHost.endsWith('.' + h))) {
            return { html: '', valid: true }
          }
        } catch { /* ignore malformed URL */ }
      }

      let html: string
      let finalUrl: string | undefined
      if (cachedHtml !== null) {
        html = cachedHtml
      } else {
        const result = await fetchUrl(targetUrl, timeoutMs)
        // Reject 4xx/5xx responses (broken links, access-denied, etc.)
        if (result.statusCode && result.statusCode >= 400) return null
        html = result.html
        finalUrl = result.finalUrl

        // Reject if the form URL redirected to a booking/SNS service
        if (finalUrl && finalUrl !== targetUrl) {
          try {
            const finalHost = new URL(finalUrl).hostname.replace(/^www\./, '')
            if (REDIRECT_REJECT_HOSTS.some((h) => finalHost === h || finalHost.endsWith('.' + h))) return null
            // Also fast-pass if it redirected to another known external form service
            if (EXTERNAL_FORM_HOSTS.some((h) => finalHost === h || finalHost.endsWith('.' + h))) {
              return { html: '', valid: true, finalUrl }
            }
          } catch { /* ignore */ }
        }

        // Soft-404 detection: if the contact page redirected back to the HP root, it doesn't exist.
        // Compare origin+pathname only (ignoring query params) so redirects like /?utm_source=xxx
        // are correctly detected as soft-404s even when tracking params differ.
        if (finalUrl && finalUrl !== targetUrl) {
          try {
            const finalOriginPath = new URL(finalUrl).origin + new URL(finalUrl).pathname.replace(/\/$/, '')
            const baseOriginPath  = new URL(effectiveBase).origin + new URL(effectiveBase).pathname.replace(/\/$/, '')
            if (finalOriginPath.toLowerCase() === baseOriginPath.toLowerCase()) return null
          } catch {
            const normFinal = finalUrl.replace(/\/$/, '').toLowerCase()
            const normBase  = effectiveBase.replace(/\/$/, '').toLowerCase()
            if (normFinal === normBase) return null
          }
        }

        // Reject if the final URL path looks like a thank-you / completion page
        // (e.g. the server auto-submitted and redirected — the "form" page is already gone)
        const checkUrl = finalUrl || targetUrl
        try {
          const finalPath = new URL(checkUrl).pathname.toLowerCase()
          if (/\/(thanks?|thankyou|thank[-_]you|complete[d]?|completion|sent|finish(?:ed)?|done|success|confirm(?:ation)?|entry[-_]?complete|sousin[-_]?kanryo|kanryo|okini[-_]nyuuri)(?:\/|\.|\?|$)/i.test(finalPath)) return null
        } catch { /* ignore */ }
      }
      if (!html) return null

      // SPA fallback: if the site is a JavaScript-rendered SPA and the contact page
      // returned a very short or JS-only shell, accept it based on URL signal alone
      // (strong URL match like /contact, /inquiry) rather than form HTML presence.
      if (!validateFormPage(html) && isSpa && URL_SEGMENT_RE.test(targetUrl)) {
        const strippedText = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        // Only accept if the page returned SOME content (not a pure 404 or redirect stub)
        if (strippedText.length >= 20 && strippedText.length < 800) {
          return { html, valid: true, finalUrl }
        }
      }

      return { html, valid: validateFormPage(html), finalUrl }
    } catch { return null }
  }

  if (fetchFormPage && extracted.formUrl && extracted.hasContactLink) {
    // LINE URLs are deep-link redirects that can't be validated via HTTP fetch.
    // Accept them directly — they were already classified as LINE by extractForms.
    if (LINE_URL_RE.test(extracted.formUrl)) {
      extracted.formTypeHint = 'LINE'
      return { url, baseUrl, ...extracted, formPageText, formPageTitle, error: null }
    }

    // If formUrl is the HP itself (inline form), reuse the already-fetched HTML
    const isInlinePage = extracted.formUrl === effectiveBase || extracted.formUrl === baseUrl
    const formHtml = isInlinePage ? hpFetch.html : null

    const primary = await tryFetchAndValidate(extracted.formUrl, formHtml)

    if (primary?.valid) {
      formPageText = cleanHtmlToText(primary.html)
      formPageTitle = extractTitle(primary.html)
      // If the form URL redirected to a different URL, store the canonical destination (strip tracking params)
      if (primary.finalUrl && primary.finalUrl !== extracted.formUrl) {
        extracted.formUrl = stripTrackingParams(primary.finalUrl)
      } else if (extracted.formUrl) {
        extracted.formUrl = stripTrackingParams(extracted.formUrl)
      }
      // Re-extract metadata from the contact page — always prefer over HP-level data.
      // The contact page is the authoritative source for the phone/email/address used for inquiry.
      const formExtras = extractForms(primary.html, extracted.formUrl!)
      if (formExtras.phone) extracted.phone = formExtras.phone
      if (formExtras.email) extracted.email = formExtras.email
      if (formExtras.address) extracted.address = formExtras.address
      // Use contact page's formTypeHint (overrides the HP-level hint for better accuracy)
      if (formExtras.formTypeHint) extracted.formTypeHint = formExtras.formTypeHint
    } else {
      // Try fallback links (lower-scored candidates)
      let validated = false
      for (const link of extracted.contactLinks.filter(l => l.url !== extracted.formUrl)) {
        const fallback = await tryFetchAndValidate(link.url, null)
        if (fallback?.valid) {
          extracted.formUrl = link.url
          formPageText = cleanHtmlToText(fallback.html)
          formPageTitle = extractTitle(fallback.html)
          const fallbackExtras = extractForms(fallback.html, link.url)
          if (fallbackExtras.phone) extracted.phone = fallbackExtras.phone
          if (fallbackExtras.email) extracted.email = fallbackExtras.email
          if (fallbackExtras.address) extracted.address = fallbackExtras.address
          if (fallbackExtras.formTypeHint) extracted.formTypeHint = fallbackExtras.formTypeHint
          validated = true
          break
        }
      }
      if (!validated) {
        // Last-chance fallback: if the HP itself has an inline form, validate it.
        // This handles sites that have contact links pointing to broken/non-form pages
        // but still embed a contact form directly on their homepage.
        if (extracted.hasInlineForm) {
          const hpValidated = validateFormPage(hpFetch.html)
          if (hpValidated) {
            extracted.formUrl = effectiveBase
            extracted.hasContactLink = true
            formPageText = cleanHtmlToText(hpFetch.html)
            formPageTitle = extractTitle(hpFetch.html)
            const hpExtras = extractForms(hpFetch.html, effectiveBase)
            if (!extracted.phone && hpExtras.phone) extracted.phone = hpExtras.phone
            if (!extracted.email && hpExtras.email) extracted.email = hpExtras.email
            if (!extracted.address && hpExtras.address) extracted.address = hpExtras.address
            extracted.formTypeHint = hpExtras.formTypeHint || 'inquiry'
            validated = true
          }
        }
        if (!validated) {
          // No validated form found — discard
          extracted.formUrl = null
          extracted.hasContactLink = false
          if (primary) {
            // Still capture page text for diagnostics
            formPageText = cleanHtmlToText(primary.html)
            formPageTitle = extractTitle(primary.html)
          }
        }
      }
    }
  }

  // Step 4 (precision boost): if still no form found, probe common contact paths.
  // Uses soft-404 detection to avoid false positives when the site serves the homepage
  // for any unknown path (common on Japanese CMS-based sites).
  if (fetchFormPage && !extracted.hasContactLink) {
    let baseOrigin: string
    // Use the redirected URL's origin so probes resolve to the correct server (e.g. https after http→https redirect)
    try { baseOrigin = new URL(effectiveBase).origin } catch { return { url, baseUrl, ...extracted, formPageText, formPageTitle, error: null } }

    const hpTitle = extractTitle(hpFetch.html).trim().toLowerCase()
    const hpLen = hpFetch.html.length
    // Normalize HP URL to origin+pathname for soft-404 comparison (ignore query params / fragments)
    let hpNorm: string
    try {
      hpNorm = (new URL(effectiveBase).origin + new URL(effectiveBase).pathname.replace(/\/$/, '')).toLowerCase()
    } catch {
      hpNorm = effectiveBase.replace(/\/$/, '').toLowerCase()
    }
    // Pre-compute HP text prefix for soft-404 detection (same content served at all paths)
    const hpTextPrefix = hpFetch.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400)

    // CMS detection: filter out irrelevant probe paths and prioritize site-appropriate ones.
    // Shopify: no CGI, no PHP, only /pages/* routes work.
    // WordPress: /pages/* won't work, but /contact, /contact-us, and /contact-form do.
    // Jimdo: contact page is always at /contact or /inquiry (clean URLs, no extensions or /pages/).
    const isShopify   = /cdn\.shopify\.com|shopify\.com\/s\/files/.test(hpFetch.html)
    const isWordPress = /wp-content\/|wp-includes\/|xmlrpc\.php/.test(hpFetch.html)
    const isJimdo     = /jimdo\.com|jimdofree\.com|jimdosite\.com/.test(hpFetch.html)
    const isWix       = /wix\.com|static\.parastorage\.com|wixstatic\.com/.test(hpFetch.html)
    const isSquare    = /squarespace\.com|static1\.squarespace\.com/.test(hpFetch.html)
    // STUDIO.design: popular Japanese no-code builder, uses clean URLs and JS rendering
    const isStudio    = /studio\.design|studiocdn\.com/.test(hpFetch.html)
    // STORES / BASE: Japanese e-commerce SaaS using /pages/* routing like Shopify
    const isStoresBase = /assets\.stores\.jp|stores\.jp\/(?:shop|assets)|itembox-assets\.com|thebase\.in\/lib|base\.shop/.test(hpFetch.html)

    const shouldProbe = (suffix: string): boolean => {
      if (isShopify || isStoresBase) {
        // Shopify / STORES / BASE: only /pages/ routes work — skip CGI, PHP, HTML/ASP-extension paths
        if (/\.(cgi|pl|php|html?|aspx?)(\?|$)/i.test(suffix)) return false
        if (/\/cgi(-bin)?\//.test(suffix)) return false
        if (/\/mail\.|\/send\.|\/post\.|\/form\./i.test(suffix)) return false
      }
      if (isWordPress) {
        // WordPress doesn't have /pages/* routes (that's Shopify's pattern)
        if (suffix.startsWith('/pages/')) return false
      }
      if (isJimdo || isWix || isSquare || isStudio) {
        // These site builders use clean URLs only — skip CGI, PHP, ASP, and HTML-extension paths
        if (/\.(cgi|pl|php|html?|aspx?)(\?|$)/i.test(suffix)) return false
        if (/\/cgi(-bin)?\//.test(suffix)) return false
        if (suffix.startsWith('/pages/')) return false
      }
      return true
    }

    // For Shopify/STORES/BASE sites, try /pages/* paths first — they're the only routes that reliably work.
    // For other sites, use the default order (most common paths first).
    const orderedProbePaths = (isShopify || isStoresBase)
      ? [
          '/pages/contact', '/pages/inquiry', '/pages/contact-us',
          '/pages/message', '/pages/form', '/pages/mailform',
          '/contact', '/contact/', '/inquiry', '/inquiry/',
          ...PROBE_PATHS.filter(p => !p.startsWith('/pages/') && ![ '/contact', '/contact/', '/inquiry', '/inquiry/'].includes(p))
        ]
      : PROBE_PATHS

    // Probe-specific timeout: shorter than the HP fetch timeout to cap worst-case probe latency.
    // With PROBE_LIMIT=15 paths, worst case drops from 15×8s=120s to 15×5s=75s.
    // Respect a custom lower timeout from the caller.
    const probeTimeoutMs = Math.min(timeoutMs, 5000)

    // Build set of URL paths already tried as contact link candidates — skip duplicates in probe loop
    // Normalize to remove trailing slashes so /contact and /contact/ are treated as the same path
    const triedPaths = new Set<string>()
    const normPath = (u: string) => { try { return new URL(u).pathname.toLowerCase().replace(/\/$/, '') } catch { return '' } }
    if (extracted.formUrl) triedPaths.add(normPath(extracted.formUrl))
    for (const link of extracted.contactLinks) triedPaths.add(normPath(link.url))

    let probed = 0
    let consecutiveSoft404s = 0  // early-abort counter: stop when 5+ consecutive probes are soft-404
    for (const suffix of orderedProbePaths) {
      if (probed >= PROBE_LIMIT) break
      // Early-abort: if many consecutive probes all look like soft-404s,
      // this site likely serves the same content at every URL path — no contact page exists.
      if (consecutiveSoft404s >= 5) break
      // Skip paths irrelevant for detected CMS
      if (!shouldProbe(suffix)) continue
      // Skip paths already tried as contact link candidates (normalize trailing slashes)
      const normSuffix = suffix.toLowerCase().replace(/\/$/, '')
      if (triedPaths.has(normSuffix)) continue
      triedPaths.add(normSuffix)  // mark as tried so /contact and /contact/ don't both get probed
      probed++
      const probeUrl = baseOrigin + suffix

      const probeResult = await fetchUrl(probeUrl, probeTimeoutMs)
      if (probeResult.error || !probeResult.html) { consecutiveSoft404s++; continue }
      // 4xx = page doesn't exist → soft-404 counter.
      // 5xx = server error → don't count against soft-404 limit (server might be temporarily down).
      if (probeResult.statusCode) {
        if (probeResult.statusCode >= 400 && probeResult.statusCode < 500) { consecutiveSoft404s++; continue }
        if (probeResult.statusCode >= 500) continue  // skip but don't penalize
      }

      const probeHtml = probeResult.html

      // ── Soft-404 detection ──────────────────────────────────────────
      // 1. Final URL is the homepage (HTTP redirect to homepage).
      // Compare origin+pathname only to catch redirects like /?utm_source=xxx.
      const probeFinalUrl = probeResult.finalUrl || probeUrl
      let probeFinalNorm: string
      try {
        probeFinalNorm = (new URL(probeFinalUrl).origin + new URL(probeFinalUrl).pathname.replace(/\/$/, '')).toLowerCase()
      } catch {
        probeFinalNorm = probeFinalUrl.replace(/\/$/, '').toLowerCase()
      }
      if (probeFinalNorm === hpNorm) { consecutiveSoft404s++; continue }

      // 1b. Final URL redirected to a booking/SNS service — reject
      if (probeResult.finalUrl && probeResult.finalUrl !== probeUrl) {
        try {
          const finalHost = new URL(probeResult.finalUrl).hostname.replace(/^www\./, '')
          if (REDIRECT_REJECT_HOSTS.some((h) => finalHost === h || finalHost.endsWith('.' + h))) { consecutiveSoft404s++; continue }
        } catch { /* ignore */ }
      }

      // 2. Same page title as homepage OR explicit 404/not-found title
      const probeTitle = extractTitle(probeHtml).trim().toLowerCase()
      const probeIs404 = /\b404\b|not.?found|ページが見つかりません|お探しのページ.*見つかりません|ページが存在しません|エラーが発生|お探しのページ|ご指定.*ページ.*存在|page.?not.?found|error.?404|アクセスエラー|お探しのページはございません|存在しないページ|削除されたページ/i.test(probeTitle)
      if (hpTitle && probeTitle && (probeTitle === hpTitle || probeIs404)) { consecutiveSoft404s++; continue }
      // Also catch generic "not found" title regardless of HP title
      if (probeIs404) { consecutiveSoft404s++; continue }

      // 3. Near-identical HTML length (within 3%) → likely same page (soft 404)
      if (hpLen > 200 && probeHtml.length > 200) {
        const lenRatio = Math.abs(hpLen - probeHtml.length) / Math.max(hpLen, probeHtml.length)
        if (lenRatio < 0.03) { consecutiveSoft404s++; continue }
      }

      // 4. Very short response → likely an error/redirect stub.
      //    SPA sites return a JS shell (~20-200 chars stripped) that is valid.
      //    For non-SPA sites keep the 300 char threshold.
      const probeText = probeHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      const minTextLen = isSpa ? 10 : 300
      if (probeText.length < minTextLen) { consecutiveSoft404s++; continue }
      // 5. Near-identical text content prefix to HP → CMS serving same page at all paths (soft-404)
      if (hpTextPrefix.length > 100 && probeText.slice(0, 400) === hpTextPrefix) { consecutiveSoft404s++; continue }
      // 6. Body text opens with a "page not found" message (custom 200 soft-404 pages)
      //    Check only the first 600 chars of stripped text to avoid false negatives on valid pages
      //    that discuss 404 errors tangentially.
      if (/お探しのページ.*見つかり|このページ.*存在しません|ページが見つかりません|存在しないページ|page not found|404 error|ご指定のページ.*見つかり|お探しのページは.*見つかりません|ページが見つかりません|お探しのページはございません|アクセスしようとしたページは.*存在しません|削除.*移動.*変更.*可能性|URLが間違っている可能性/i.test(probeText.slice(0, 600))) { consecutiveSoft404s++; continue }
      // ───────────────────────────────────────────────────────────────

      // A page that passed all soft-404 checks resets the consecutive counter
      consecutiveSoft404s = 0

      // SPA probe fallback: URL_SEGMENT_RE match is sufficient validation for JS-rendered sites
      const probeValid = validateFormPage(probeHtml)
        || (isSpa && URL_SEGMENT_RE.test(suffix) && probeText.length < 800)
      if (!probeValid) continue

      // Use the canonical URL after redirect (e.g. /contact → /contact/index.php); strip tracking params
      extracted.formUrl = stripTrackingParams((probeResult.finalUrl && probeResult.finalUrl !== probeUrl) ? probeResult.finalUrl : probeUrl)
      extracted.hasContactLink = true
      formPageText = cleanHtmlToText(probeHtml)
      formPageTitle = probeTitle || extractTitle(probeHtml)
      // Re-extract metadata from the actual contact page (phone, email, address, formTypeHint)
      const probeExtracted = extractForms(probeHtml, probeUrl)
      // Always prefer contact-page phone/email/address over HP-level data (more authoritative)
      if (probeExtracted.phone) extracted.phone = probeExtracted.phone
      if (probeExtracted.email) extracted.email = probeExtracted.email
      if (probeExtracted.address) extracted.address = probeExtracted.address
      // Use contact page's formTypeHint (more accurate than HP-level hint)
      extracted.formTypeHint = probeExtracted.formTypeHint || 'inquiry'
      break
    }
  }

  return { url, baseUrl, ...extracted, formPageText, formPageTitle, error: null }
}

/**
 * Sliding-window concurrent processor.
 * Keeps at most `concurrency` items in-flight at all times.
 * Unlike fixed-batch mode, fast completions immediately free slots for new items.
 *
 * Deduplication: if the same HP URL appears multiple times in the batch, all copies
 * share a single in-flight Promise — no duplicate network requests.
 */
async function processBatch(
  items: Array<{ url: string; baseUrl: string }>,
  timeoutMs: number,
  concurrency: number,
  fetchFormPage: boolean
): Promise<FormExtractResult[]> {
  const results: FormExtractResult[] = new Array(items.length)
  let nextIndex = 0

  // url → Promise for deduplication across concurrent workers
  const inFlight = new Map<string, Promise<FormExtractResult>>()

  const worker = async () => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) break
      const item = items[i]

      let promise = inFlight.get(item.url)
      if (!promise) {
        promise = processItem(item.url, item.baseUrl, timeoutMs, fetchFormPage)
        inFlight.set(item.url, promise)
      }
      results[i] = await promise
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, worker)
  await Promise.all(workers)
  return results
}

export async function POST(req: NextRequest) {
  // Per-IP rate limiting: n8n runs on the same host so its IP is effectively internal,
  // but this guards against accidental or abusive external callers.
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? req.headers.get('x-real-ip')
    ?? 'unknown'
  const rateCheck = checkRateLimit(ip)
  if (!rateCheck.allowed) {
    const retryAfterSec = Math.ceil(rateCheck.resetMs / 1000)
    return NextResponse.json(
      { success: false, error: `Rate limit exceeded. Try again in ${retryAfterSec}s.` },
      { status: 429, headers: { 'Retry-After': String(retryAfterSec), 'X-RateLimit-Remaining': '0' } }
    )
  }
  if (_activeBatches >= MAX_CONCURRENT_BATCHES) {
    return NextResponse.json(
      { success: false, error: 'Server busy — too many concurrent scraping jobs. Retry in a few seconds.' },
      { status: 429, headers: { 'Retry-After': '5' } }
    )
  }
  _activeBatches++
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
  } finally {
    _activeBatches--
  }
}
