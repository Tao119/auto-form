import { NextRequest, NextResponse } from 'next/server'
import * as https from 'https'
import * as http from 'http'
import { URL } from 'url'
import { z } from 'zod'

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
        const MAX_BYTES = 200_000 // 200KB sufficient for link scanning

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (totalBytes <= MAX_BYTES) { chunks.push(chunk) } else { res.destroy() }
        })
        res.on('end', () => {
          clearTimeout(tid)
          const html = Buffer.concat(chunks).toString('utf8')
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
  // Specific contact-page text anchors — require the link text to clearly say "contact us"
  const CONTACT_TEXT_KW = [
    'お問い合わせ','お問合わせ','お問合せ','otoiawase',
    'contact us','contact form','inquiry','問い合わせフォーム',
    'ご相談','メールフォーム','メール送信','renraku','goiken',
    'ご連絡','無料相談','資料請求','send message','write to us','get in touch',
    // Looser (lower weight) — matched as text but NOT sole basis for accepting
    'contact','feedback',
  ]
  // URL-path patterns that strongly suggest a contact page
  const CONTACT_URL_KW = [
    'contact','inquiry','toiawase','otoiawase','mailform',
    'ask-us','askus','feedback','renraku','goiken',
    'お問い合わせ','問い合わせ','ご相談','ご連絡','cgi-bin','cgi/',
    // Note: 'form','mail','send','message','support' intentionally removed — too generic
  ]
  const BOOKING_KW = [
    '予約','ご予約','reservation','booking','ネット予約','hotpepper',
    'reserve','yoyaku','minimo','beauty.hotpepper',
  ]
  // Booking service hostnames — links pointing here are always treated as booking, never inquiry
  const BOOKING_URL_HOSTS = [
    'coubic.com','airreserve.net','reserva.be','minimo.io',
    'tablecheck.com','ebica.jp','toreta.in','hotpepper.jp',
    'beauty.hotpepper.jp','select-type.com','icalendar.jp',
    'reservestock.jp','reservia.jp',
  ]
  const EXTERNAL_FORM_HOSTS = [
    // Google Forms
    'docs.google.com','forms.gle',
    // Japanese form SaaS (inquiry / contact)
    'form.run','tayori.com','form.kintoneapp.com','kintone.com',
    'formzu.net','freeml.net','formmailer.jp',
    // International form SaaS
    'formstack.com','typeform.com','jotform.com','tally.so','paperform.co',
    'wufoo.com','surveymonkey.com','cognito-forms.com',
    // LINE (contact via LINE Messenger)
    'lin.ee','page.line.me','accountpage.line.me','liff.line.me',
    // Other
    'mailchimp.com','zoho.com',
    // NOTE: booking services (coubic, airreserve, etc.) are in BOOKING_URL_HOSTS and always rejected
  ]

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
      isExternal = baseHost !== linkHost
      if (isExternal && !EXTERNAL_FORM_HOSTS.some((h) => linkHost.includes(h))) continue
    } catch { continue }

    const lText = rawText.toLowerCase()
    const lUrl = absoluteUrl.toLowerCase()

    const isBooking = BOOKING_KW.some((kw) => lText.includes(kw.toLowerCase()) || lUrl.includes(kw.toLowerCase()))
      || BOOKING_URL_HOSTS.some((h) => linkHost.includes(h))
    if (isBooking) continue

    let score = 0
    for (const kw of CONTACT_TEXT_KW) { if (lText.includes(kw.toLowerCase())) { score += 10; break } }

    // URL path matching: require word boundaries to avoid false positives
    // e.g. /contact, /contact.html, /contact/, /contact? but NOT /contactlist, /subcontract
    const URL_SEGMENT_RE = /(?:^|\/)(contact|inquiry|toiawase|otoiawase|mailform|ask-us|askus|feedback|renraku|goiken)(?:\/|\.|\?|_|-|$)/i
    const URL_LOOSE_RE = /(?:%E3%81%8A%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B|%E5%95%8F%E3%81%84%E5%90%88%E3%82%8F%E3%81%9B|%E3%81%94%E7%9B%B8%E8%AB%87|cgi-bin|cgi\/)/i
    if (URL_SEGMENT_RE.test(lUrl) || URL_LOOSE_RE.test(lUrl)) score += 8
    // Japanese URL keywords (highly specific, substring match is safe)
    if (lUrl.includes('お問い合わせ') || lUrl.includes('問い合わせ') || lUrl.includes('ご相談') || lUrl.includes('ご連絡')) score += 8
    // CGI form pattern
    if (/\/cgi(-bin)?\/.*form/i.test(absoluteUrl)) score += 12
    if (isExternal) score += 15

    // Require at least a URL keyword match (8) OR a strong text match (10) to accept
    if (score >= 8) links.push({ url: absoluteUrl, text: rawText.slice(0, 80), score })
  }
  links.sort((a, b) => b.score - a.score)

  const mailtoM = html.match(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/i)
  // Fallback email from page text: require realistic TLD (2-6 chars) and exclude CSS-like patterns
  // Strip tags first to avoid matching `class="foo@bar"` style attributes
  const plainText = html.replace(/<[^>]+>/g, ' ')
  const emailM = plainText.match(/\b([a-zA-Z0-9._%+\-]{3,}@[a-zA-Z0-9.\-]+\.[a-z]{2,6})\b/)
  const email = mailtoM ? mailtoM[1] : (emailM && !emailM[1].endsWith('.js') && !emailM[1].endsWith('.css') ? emailM[1] : null)

  // tel: link is most reliable; fall back to text patterns with hyphen/en-dash/em-dash separators
  const phoneM = html.match(/tel:([\d\-+\s()]{8,15})/i)
    || html.match(/(0\d{1,4}[－\-–—]\d{1,4}[－\-–—]\d{3,4})/)
    || html.match(/(0[0-9]{9,10})/)  // 11-digit mobile like 09012345678
  const phone = phoneM ? phoneM[1].replace(/[\s－–—]/g, '-').trim() : null

  let hasContactLink = links.length > 0
  let formUrl: string | null = links.length > 0 ? links[0].url : null

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
  const LINE_HINT_PATTERNS = [/lin\.ee\//i, /page\.line\.me\//i, /accountpage\.line\.me\//i, /liff\.line\.me\//i]
  let formTypeHint: 'inquiry' | 'booking' | 'LINE' | null = null
  if (formUrl && LINE_HINT_PATTERNS.some((re) => re.test(formUrl!))) {
    formTypeHint = 'LINE'
  } else if (BOOKING_KW.some((kw) => lHtml.includes(kw.toLowerCase())) && !hasInlineForm) {
    formTypeHint = 'booking'
  } else if (hasContactLink || hasInlineForm) {
    formTypeHint = 'inquiry'
  }

  return { formUrl, email, phone, hasContactLink, hasInlineForm, hasEmailContact, formTypeHint, contactLinks: links.slice(0, 3) }
}

/**
 * Verify that a fetched HTML page actually contains a contact / inquiry form.
 * Rejects login pages, search boxes, newsletter signups, blog comments, thank-you pages, etc.
 *
 * Design goals:
 *  - High precision over recall: when in doubt, reject.  GPT does the final call.
 *  - Textarea + specific Japanese/English inquiry keyword → accept.
 *  - Email/tel input + submit → only accept when keyword appears IN the form context,
 *    not just anywhere on the page (prevents newsletter-on-homepage false positives).
 */
function validateFormPage(html: string): boolean {
  // External form embeds always accepted (Google Forms, Tayori, typeform, etc.)
  if (/docs\.google\.com\/forms|form\.run|typeform\.com|jotform\.com|tayori\.com|formstack\.com|coubic\.com|formzu\.net|form\.kintoneapp/i.test(html)) return true

  // Reject confirmed thank-you / completion pages
  const titleM = html.match(/<title[^>]*>([^<]*)<\/title>/i)
  const title = titleM ? titleM[1].toLowerCase() : ''
  if (/送信完了|ありがとうございます|受け付けました|thank you|submission complete|success/.test(title)) {
    if (!/<form[\s>]/i.test(html)) return false
  }

  if (!/<form[\s>]/i.test(html)) return false

  // ── Textarea path ────────────────────────────────────────────────────────
  // Textarea is the strongest inquiry signal.  Accept only when a specific
  // inquiry-related keyword appears on the page (avoids blog comments, reviews).
  // "message" and generic "content/内容" intentionally excluded — too noisy.
  if (/textarea/i.test(html)) {
    const INQUIRY_KW = /お問い合わせ|ご連絡|ご相談|お問合|inquiry|contact us|contact form|ご質問|お問い合わせ内容|お問合せ内容|メッセージ内容|ご意見/i
    if (INQUIRY_KW.test(html)) return true
    // Textarea without inquiry keyword: only accept if name + email fields present
    // (catches minimal contact forms that label fields generically)
    const hasNameField = /<input[^>]+(name|id)=["']?(?:name|your[_-]?name|お名前|namae)/i.test(html)
    const hasEmailField = /<input[^>]+type=["']?email/i.test(html)
    if (hasNameField && hasEmailField) return true
    // fallback: any text input + email field + submit (covers generic English forms)
    const hasTextInput = /<input[^>]+type=["']?text/i.test(html)
    const hasSubmitFallback = /<(input|button)[^>]*type=["']?submit/i.test(html)
    if (hasTextInput && hasEmailField && hasSubmitFallback) return true
  }

  // ── Email/tel + submit path ──────────────────────────────────────────────
  // Require the inquiry keyword to appear WITHIN the form element's HTML context
  // (prevents newsletter signup on homepage from matching "contact" link text elsewhere).
  const hasContactInput = /<input[^>]+type=["']?(email|tel)/i.test(html)
  const hasSubmit = /<(input|button)[^>]*type=["']?submit/i.test(html)
  if (hasContactInput && hasSubmit) {
    const formIdx = html.toLowerCase().indexOf('<form')
    const formContext = formIdx !== -1
      ? html.slice(Math.max(0, formIdx - 500), Math.min(html.length, formIdx + 4000))
      : html
    const FORM_KW = /お問い合わせ|ご連絡|ご相談|お問合|inquiry|contact us|contact form|ご質問|お問い合わせ内容/i
    if (FORM_KW.test(formContext)) return true
  }

  return false
}

/**
 * Common contact page paths to probe when no form link is found via link extraction.
 * Ordered by likelihood. We try at most PROBE_LIMIT paths to keep latency bounded.
 */
const PROBE_PATHS = [
  '/contact', '/inquiry', '/otoiawase', '/toiawase', '/mailform',
  '/form', '/contact.html', '/inquiry.html', '/contact.php', '/inquiry.php',
  '/contact/', '/inquiry/', '/otoiawase/', '/toiawase/',
  '/contact/index.html', '/inquiry/index.html',
]
const PROBE_LIMIT = 4  // max paths to probe per site

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
  const extracted = extractForms(hpFetch.html, baseUrl)

  // Step 3: fetch form page and validate it actually contains a contact form
  let formPageText: string | null = null
  let formPageTitle: string | null = null

  const tryFetchAndValidate = async (targetUrl: string, cachedHtml: string | null): Promise<{ html: string; valid: boolean } | null> => {
    try {
      let html: string
      if (cachedHtml !== null) {
        html = cachedHtml
      } else {
        const result = await fetchUrl(targetUrl, timeoutMs)
        // Reject 4xx/5xx responses (broken links, access-denied, etc.)
        if (result.statusCode && result.statusCode >= 400) return null
        html = result.html
      }
      if (!html) return null
      return { html, valid: validateFormPage(html) }
    } catch { return null }
  }

  if (fetchFormPage && extracted.formUrl && extracted.hasContactLink) {
    // If formUrl is the HP itself (inline form), reuse the already-fetched HTML
    const isInlinePage = extracted.formUrl === baseUrl
    const formHtml = isInlinePage ? hpFetch.html : null

    const primary = await tryFetchAndValidate(extracted.formUrl, formHtml)

    if (primary?.valid) {
      formPageText = cleanHtmlToText(primary.html)
      formPageTitle = extractTitle(primary.html)
    } else {
      // Try fallback links (lower-scored candidates)
      let validated = false
      for (const link of extracted.contactLinks.filter(l => l.url !== extracted.formUrl)) {
        const fallback = await tryFetchAndValidate(link.url, null)
        if (fallback?.valid) {
          extracted.formUrl = link.url
          formPageText = cleanHtmlToText(fallback.html)
          formPageTitle = extractTitle(fallback.html)
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
    try { baseOrigin = new URL(baseUrl).origin } catch { return { url, baseUrl, ...extracted, formPageText, formPageTitle, error: null } }

    const hpTitle = extractTitle(hpFetch.html).trim().toLowerCase()
    const hpLen = hpFetch.html.length
    const hpNorm = baseUrl.replace(/\/$/, '').toLowerCase()

    let probed = 0
    for (const suffix of PROBE_PATHS) {
      if (probed >= PROBE_LIMIT) break
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

      // 2. Same page title as homepage → likely same content served at every path
      const probeTitle = extractTitle(probeHtml).trim().toLowerCase()
      if (hpTitle && probeTitle && probeTitle === hpTitle) continue

      // 3. Near-identical HTML length (within 3%) → likely same page (soft 404)
      if (hpLen > 200 && probeHtml.length > 200) {
        const lenRatio = Math.abs(hpLen - probeHtml.length) / Math.max(hpLen, probeHtml.length)
        if (lenRatio < 0.03) continue
      }
      // ───────────────────────────────────────────────────────────────

      if (!validateFormPage(probeHtml)) continue

      extracted.formUrl = probeUrl
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
