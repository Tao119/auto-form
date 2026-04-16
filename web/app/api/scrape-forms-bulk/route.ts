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

// ── Shared HTTP agents with keep-alive ────────────────────────────
// Connection reuse significantly reduces latency for sequential fetches to the
// same host (HP fetch → form page validation → probe paths).
const _httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32 })
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 32, rejectUnauthorized: false })

// ── Contact extraction constants ──────────────────────────────────────────────
// Defined at module scope to avoid re-allocation on every request
// (extractForms and validateFormPage are called multiple times per item).

const CONTACT_TEXT_KW = [
  'お問い合わせ','お問合わせ','お問合せ','otoiawase',
  'contact us','contact form','inquiry','問い合わせフォーム',
  'ご相談','メールフォーム','メール送信','renraku','goiken',
  'ご連絡','無料相談','資料請求','send message','write to us','get in touch',
  // Looser (lower weight) — matched as text but NOT sole basis for accepting
  'contact','feedback',
]
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
]
const EXTERNAL_FORM_HOSTS = [
  'docs.google.com','forms.gle',
  'form.run','tayori.com','form.kintoneapp.com','kintone.com',
  'formzu.net','freeml.net','formmailer.jp',
  'formstack.com','typeform.com','jotform.com','tally.so','paperform.co',
  'wufoo.com','surveymonkey.com','cognito-forms.com',
  'share.hsforms.com','forms.hubspot.com',
  'share.formsite.com',
  'app.getresponse.com',
  'lin.ee','page.line.me','accountpage.line.me','liff.line.me',
  'mailchimp.com','zoho.com',
]
// URL path suffixes that clearly indicate non-contact pages.
// Trailing boundary (\/|\.|\?|$) prevents partial matches: /recruit-info is NOT rejected.
const NON_CONTACT_SUFFIX_RE = /\/(privacy[-_]?(?:policy)?|terms?(?:[-_]of[-_]service)?|sitemap|blog|news|articles?|posts?|shop|cart|login|sign[-_]?up|register|logout|faq|access(?:map)?|recruit(?:ment)?|career|jobs?|about(?:-us)?|company|profile|gallery|works|portfolio|media|press)(?:\/|\.|\?|$)/i
// URL segment patterns that strongly suggest a dedicated contact page
const URL_SEGMENT_RE = /(?:^|\/)(contact|inquiry|toiawase|otoiawase|mailform|ask-us|askus|feedback|renraku|goiken|iawase|gorenraku|gosodan)(?:\/|\.|\?|_|-|$)/i
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
]
// Fast-pass for known external form SaaS — page is a valid contact form without further analysis
const EXTERNAL_FORM_FAST_PASS_RE = /docs\.google\.com\/forms|forms\.gle|form\.run|formrun\.com|typeform\.com|jotform\.com|tayori\.com|formstack\.com|formzu\.net|form\.kintoneapp|kintone\.com|freeml\.net|mailform\.jp|mfcontact\.com|mfcontacts\.com|formmailer\.jp|tally\.so|paperform\.co|cognito-forms\.com|wufoo\.com|surveymonkey\.com|share\.hsforms\.com|forms\.hubspot\.com|share\.formsite\.com|app\.getresponse\.com|mailchimp\.com|zoho\.com/i

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
  hasContactLink: boolean
  hasInlineForm: boolean
  hasEmailContact: boolean
  contactLinks: Array<{ url: string; text: string; score: number }>
  formPageText: string | null  // cleaned text from form page (for GPT)
  formPageTitle: string | null
  formTypeHint: 'inquiry' | 'booking' | 'LINE' | null  // detected form type hint
  error: string | null
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
          const encoding = (res.headers['content-encoding'] || '').toLowerCase()
          const processHtml = (html: string) => {
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
          if (encoding === 'gzip') {
            zlib.gunzip(rawBuf, (err, decoded) => processHtml(err ? rawBuf.toString('utf8') : decoded.toString('utf8')))
          } else if (encoding === 'deflate') {
            zlib.inflate(rawBuf, (err, decoded) => processHtml(err ? rawBuf.toString('utf8') : decoded.toString('utf8')))
          } else if (encoding === 'br') {
            zlib.brotliDecompress(rawBuf, (err, decoded) => processHtml(err ? rawBuf.toString('utf8') : decoded.toString('utf8')))
          } else {
            processHtml(rawBuf.toString('utf8'))
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
 */
function cleanHtmlToText(html: string): string {
  const formIdx = html.toLowerCase().indexOf('<form')
  if (formIdx !== -1) {
    // Take 1 500 chars before the form (for headings/breadcrumbs) + 2 500 after
    const start = Math.max(0, formIdx - 1500)
    const end = Math.min(html.length, formIdx + 2500)
    const segment = html.slice(start, end)
    return stripHtmlTags(segment).slice(0, 3000)
  }
  return stripHtmlTags(html).slice(0, 3000)
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
  formTypeHint: 'inquiry' | 'booking' | 'LINE' | null
  contactLinks: Array<{ url: string; text: string; score: number }>
} {
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
    let linkHost = ''
    let isExternal = false
    try {
      absoluteUrl = new URL(rawHref, baseUrl).toString()
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

    const isBooking = BOOKING_KW.some((kw) => lText.includes(kw.toLowerCase()) || lUrl.includes(kw.toLowerCase()))
      || BOOKING_URL_HOSTS.some((h) => linkHost.includes(h))
    if (isBooking) continue

    // Reject links whose URL path clearly indicates non-contact content.
    if (NON_CONTACT_SUFFIX_RE.test(lUrl)) continue

    let score = 0
    for (const kw of CONTACT_TEXT_KW) { if (lText.includes(kw.toLowerCase())) { score += 10; break } }

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
  links.sort((a, b) => b.score - a.score)
  // Deduplicate by URL (same contact page often linked from nav + footer — keep highest score)
  const _seenLinkUrls = new Set<string>()
  const uniqueLinks = links.filter((l) => {
    const k = l.url.toLowerCase().replace(/\/$/, '')
    if (_seenLinkUrls.has(k)) return false
    _seenLinkUrls.add(k)
    return true
  })

  const mailtoM = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
  // Fallback email from page text: require realistic TLD (2-6 chars) and exclude CSS-like patterns
  // Strip tags first to avoid matching `class="foo@bar"` style attributes
  const plainText = html.replace(/<[^>]+>/g, ' ')
  const emailM = plainText.match(/\b([a-zA-Z0-9._%+\-]{3,}@[a-zA-Z0-9.\-]+\.[a-z]{2,6})\b/)
  const email = mailtoM ? mailtoM[1] : (emailM && !emailM[1].endsWith('.js') && !emailM[1].endsWith('.css') ? emailM[1] : null)

  // Phone extraction: tel: link is most reliable.
  // Fallback patterns handle:
  //   - Hyphens/dashes:  03-1234-5678  or  03－1234－5678
  //   - Brackets:        03(1234)5678  or  03（1234）5678
  //   - Compact:         0312345678  (10-11 digits with leading 0)
  //   - Country code:    +81-3-1234-5678
  const phoneM = html.match(/tel:([\d\-+\s()]{7,20})/i)
    || html.match(/(0\d{1,4}[－\-–—(（]\d{1,4}[)）\-–—]\d{3,4})/)  // hyphen or bracket style
    || html.match(/(0[0-9]{9,10})/)              // compact 10-11 digit number
    || html.match(/(\+81[\-\s\d]{8,16})/)        // international +81 prefix
  const rawPhone = phoneM ? phoneM[1].replace(/[（(]/g, '(').replace(/[）)]/g, ')').replace(/[－–—]/g, '-').replace(/\s+/g, '').trim() : null
  // Validate: stripped digits must be 10-11 (JP domestic) or start with +81 (international)
  const phoneDigits = rawPhone ? rawPhone.replace(/[^\d]/g, '') : ''
  const phone = rawPhone && (
    (phoneDigits.length >= 10 && phoneDigits.length <= 11 && phoneDigits.startsWith('0')) ||
    rawPhone.startsWith('+81')
  ) ? rawPhone : null

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
        const actionUrl = new URL(faMatch[1], baseUrl)
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
        const iframeUrl = new URL(ifMatch[1], baseUrl)
        const iframeHost = iframeUrl.hostname.replace(/^www\./, '')
        if (EXTERNAL_FORM_HOSTS.some((h) => iframeHost.includes(h))) {
          formUrl = iframeUrl.toString()
          hasContactLink = true
          break
        }
      } catch { /* ignore */ }
    }
  }

  const hasEmailContact = !!email
  // NOTE: email-only sites are NOT counted as having a contact form.
  // Email is stored for reference but formUrl must point to an actual web form.

  // Determine formTypeHint from detected links and page content
  const lHtml = html.toLowerCase()
  let formTypeHint: 'inquiry' | 'booking' | 'LINE' | null = null
  if (formUrl && LINE_HINT_PATTERNS.some((re) => re.test(formUrl!))) {
    formTypeHint = 'LINE'
  } else if (BOOKING_KW.some((kw) => lHtml.includes(kw.toLowerCase())) && !hasInlineForm) {
    formTypeHint = 'booking'
  } else if (hasContactLink || hasInlineForm) {
    formTypeHint = 'inquiry'
  }

  return { formUrl, email, phone, hasContactLink, hasInlineForm, hasEmailContact, formTypeHint, contactLinks: uniqueLinks.slice(0, 3) }
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

  // Reject WordPress / blog CMS comment forms.
  // These have textarea + name/email but are comment sections, not inquiry forms.
  if (/(?:class|id)=["'][^"']*(?:comment[-_]?form|wp-comment|respond|leave[-_]?a[-_]?reply)[^"']*["']/i.test(formCtx)) return false
  // Also reject if the form/surrounding context talks about comments, not inquiries
  const lCtx = formCtx.toLowerCase()
  if (/コメント|comment|leave a reply|返信する|reply to/.test(lCtx) && !/お問い合わせ|ご連絡|ご相談|inquiry|contact/i.test(lCtx)) return false

  // ── Textarea path ───────────────────────────────────────────────
  // The 800-char pre-window often contains headings like "お問い合わせ"
  // right above the form — strong signal for contact forms.
  if (/textarea/i.test(formCtx)) {
    const INQUIRY_KW = /お問い合わせ|ご連絡|ご相談|お問合|inquiry|contact us|contact form|ご質問|お問い合わせ内容|お問合せ内容|メッセージ内容|ご意見/i
    if (INQUIRY_KW.test(formCtx)) return true
    const hasNameField = /<input[^>]+(name|id)=["']?(?:name|your[_-]?name|お名前|namae)/i.test(formCtx)
    const hasEmailField = /<input[^>]+type=["']?email/i.test(formCtx)
    if (hasNameField && hasEmailField) return true
    const hasTextInput = /<input[^>]+type=["']?text/i.test(formCtx)
    const hasSubmitFallback = /<(input|button)[^>]*type=["']?submit/i.test(formCtx)
    if (hasTextInput && hasEmailField && hasSubmitFallback) return true
    // Relaxed: textarea + submit + 2+ text inputs + email-like field name
    // (Handles old Japanese sites where email uses type="text" instead of type="email")
    // Requiring an email-like field prevents reservation forms from matching.
    const hasEmailLikeField = /<input[^>]+(name|id)=["']?(?:e-?mail|mail|メール|your.?mail|your.?email|yourmail)/i.test(formCtx)
    const textInputCount = (formCtx.match(/<input[^>]+type=["']?text/gi) || []).length
    if (hasSubmitFallback && textInputCount >= 2 && hasEmailLikeField) return true
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
function validateFormPage(html: string): boolean {
  // External form embeds always accepted — checks both fast-path (Google Forms, etc.) and
  // additional known form SaaS services that may appear in iframe src or form action attributes.
  if (EXTERNAL_FORM_FAST_PASS_RE.test(html)) return true
  // LINE contact links — always valid contact method
  if (LINE_CONTACT_RE.test(html)) return true

  // Reject confirmed thank-you / completion pages (no form present)
  const titleM = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleM ? titleM[1].toLowerCase() : ''
  if (/送信完了|ありがとうございます|受け付けました|thank you|submission complete|success/.test(title)) {
    if (!/<form[\s>]/i.test(html)) return false
  }
  // Reject pages whose title strongly suggests non-contact content and have no form
  if (/ニュース|news|プレスリリース|お知らせ一覧|アクセス|access|採用|recruit|サービス一覧|実績|ブログ|blog|プライバシー|privacy|利用規約|terms|サイトマップ|sitemap|会社概要|ギャラリー|gallery/.test(title)) {
    if (!/<form[\s>]/i.test(html)) return false
  }

  if (!/<form[\s>]/i.test(html)) return false

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
  // Shopify / Square Online: pages are nested under /pages/
  '/pages/contact', '/pages/inquiry', '/pages/contact-us',
  // URL-encoded Japanese paths
  '/%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B',  // /お問い合わせ
  '/%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B',            // /問い合わせ
  '/%E3%81%8A%E5%95%8F%E5%90%88%E3%81%9B',                     // /お問合せ
]
const PROBE_LIMIT = 12  // max paths to probe per site

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
      formTypeHint: null, contactLinks: [], formPageText: null, formPageTitle: null,
      error: hpFetch.error,
    }
  }

  // Step 2: extract form links
  // Use finalUrl as the base for link resolution — handles http→https redirects and
  // domain migrations so relative links like /contact resolve to the correct origin.
  const effectiveBase = (hpFetch.finalUrl && hpFetch.finalUrl !== url) ? hpFetch.finalUrl : baseUrl

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
          url, baseUrl, formUrl: null, email: null, phone: null,
          hasContactLink: false, hasInlineForm: false, hasEmailContact: false,
          formTypeHint: null, contactLinks: [], formPageText: null, formPageTitle: null, error: null,
        }
      }
    } catch { /* ignore */ }
  }

  const extracted = extractForms(hpFetch.html, effectiveBase)

  const tryFetchAndValidate = async (targetUrl: string, cachedHtml: string | null): Promise<{ html: string; valid: boolean; finalUrl?: string } | null> => {
    try {
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
          } catch { /* ignore */ }
        }

        // Soft-404 detection: if the contact page redirected back to the HP root, it doesn't exist
        if (finalUrl && finalUrl !== targetUrl) {
          const normFinal = finalUrl.replace(/\/$/, '').toLowerCase()
          const normBase  = effectiveBase.replace(/\/$/, '').toLowerCase()
          if (normFinal === normBase) return null
        }
      }
      if (!html) return null
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
      // If the form URL redirected to a different URL, store the canonical destination
      if (primary.finalUrl && primary.finalUrl !== extracted.formUrl) {
        extracted.formUrl = primary.finalUrl
      }
      // Re-extract metadata from the contact page: more accurate than the HP
      const formExtras = extractForms(primary.html, extracted.formUrl!)
      if (!extracted.phone && formExtras.phone) extracted.phone = formExtras.phone
      if (!extracted.email && formExtras.email) extracted.email = formExtras.email
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
          if (!extracted.phone && fallbackExtras.phone) extracted.phone = fallbackExtras.phone
          if (!extracted.email && fallbackExtras.email) extracted.email = fallbackExtras.email
          if (fallbackExtras.formTypeHint) extracted.formTypeHint = fallbackExtras.formTypeHint
          validated = true
          break
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

  // Step 4 (precision boost): if still no form found, probe common contact paths.
  // Uses soft-404 detection to avoid false positives when the site serves the homepage
  // for any unknown path (common on Japanese CMS-based sites).
  if (fetchFormPage && !extracted.hasContactLink) {
    let baseOrigin: string
    // Use the redirected URL's origin so probes resolve to the correct server (e.g. https after http→https redirect)
    try { baseOrigin = new URL(effectiveBase).origin } catch { return { url, baseUrl, ...extracted, formPageText, formPageTitle, error: null } }

    const hpTitle = extractTitle(hpFetch.html).trim().toLowerCase()
    const hpLen = hpFetch.html.length
    const hpNorm = effectiveBase.replace(/\/$/, '').toLowerCase()
    // Pre-compute HP text prefix for soft-404 detection (same content served at all paths)
    const hpTextPrefix = hpFetch.html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 400)

    // Build set of URL paths already tried as contact link candidates — skip duplicates in probe loop
    // Normalize to remove trailing slashes so /contact and /contact/ are treated as the same path
    const triedPaths = new Set<string>()
    const normPath = (u: string) => { try { return new URL(u).pathname.toLowerCase().replace(/\/$/, '') } catch { return '' } }
    if (extracted.formUrl) triedPaths.add(normPath(extracted.formUrl))
    for (const link of extracted.contactLinks) triedPaths.add(normPath(link.url))

    let probed = 0
    for (const suffix of PROBE_PATHS) {
      if (probed >= PROBE_LIMIT) break
      // Skip paths already tried as contact link candidates (normalize trailing slashes)
      const normSuffix = suffix.toLowerCase().replace(/\/$/, '')
      if (triedPaths.has(normSuffix)) continue
      triedPaths.add(normSuffix)  // mark as tried so /contact and /contact/ don't both get probed
      probed++
      const probeUrl = baseOrigin + suffix

      const probeResult = await fetchUrl(probeUrl, timeoutMs)
      if (probeResult.error || !probeResult.html) continue
      if (probeResult.statusCode && probeResult.statusCode >= 400) continue

      const probeHtml = probeResult.html

      // ── Soft-404 detection ──────────────────────────────────────────
      // 1. Final URL is the homepage (HTTP redirect to homepage)
      const probeFinalNorm = (probeResult.finalUrl || probeUrl).replace(/\/$/, '').toLowerCase()
      if (probeFinalNorm === hpNorm) continue

      // 1b. Final URL redirected to a booking/SNS service — reject
      if (probeResult.finalUrl && probeResult.finalUrl !== probeUrl) {
        try {
          const finalHost = new URL(probeResult.finalUrl).hostname.replace(/^www\./, '')
          if (REDIRECT_REJECT_HOSTS.some((h) => finalHost === h || finalHost.endsWith('.' + h))) continue
        } catch { /* ignore */ }
      }

      // 2. Same page title as homepage OR explicit 404/not-found title
      const probeTitle = extractTitle(probeHtml).trim().toLowerCase()
      const probeIs404 = /\b404\b|not.?found|ページが見つかりません|お探しのページ.*見つかりません|ページが存在しません/i.test(probeTitle)
      if (hpTitle && probeTitle && (probeTitle === hpTitle || probeIs404)) continue
      // Also catch generic "not found" title regardless of HP title
      if (probeIs404) continue

      // 3. Near-identical HTML length (within 3%) → likely same page (soft 404)
      if (hpLen > 200 && probeHtml.length > 200) {
        const lenRatio = Math.abs(hpLen - probeHtml.length) / Math.max(hpLen, probeHtml.length)
        if (lenRatio < 0.03) continue
      }

      // 4. Very short response (< 300 bytes stripped) → likely an error/redirect stub
      const probeText = probeHtml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
      if (probeText.length < 300) continue
      // 5. Near-identical text content prefix to HP → CMS serving same page at all paths (soft-404)
      if (hpTextPrefix.length > 100 && probeText.slice(0, 400) === hpTextPrefix) continue
      // ───────────────────────────────────────────────────────────────

      if (!validateFormPage(probeHtml)) continue

      // Use the canonical URL after redirect (e.g. /contact → /contact/index.php)
      extracted.formUrl = (probeResult.finalUrl && probeResult.finalUrl !== probeUrl) ? probeResult.finalUrl : probeUrl
      extracted.hasContactLink = true
      formPageText = cleanHtmlToText(probeHtml)
      formPageTitle = probeTitle || extractTitle(probeHtml)
      // Re-extract metadata from the actual contact page (phone, email, formTypeHint)
      const probeExtracted = extractForms(probeHtml, probeUrl)
      if (!extracted.phone && probeExtracted.phone) extracted.phone = probeExtracted.phone
      if (!extracted.email && probeExtracted.email) extracted.email = probeExtracted.email
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
  if (_activeBatches >= MAX_CONCURRENT_BATCHES) {
    return NextResponse.json(
      { success: false, error: 'Server busy — too many concurrent scraping jobs. Retry in a few seconds.' },
      { status: 429 }
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
