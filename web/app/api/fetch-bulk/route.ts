import { NextRequest, NextResponse } from 'next/server'
import * as https from 'https'
import * as http from 'http'
import * as zlib from 'zlib'
import { URL } from 'url'
import { z } from 'zod'

// Allow at most 3 concurrent fetch-bulk jobs to prevent OOM when n8n fires multiple webhooks
const MAX_CONCURRENT_FETCHES = 3
let _activeFetches = 0

const _httpAgent  = new http.Agent({ keepAlive: true, maxSockets: 64 })
const _httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false })

const Schema = z.object({
  urls: z.array(z.string()).min(1),
  timeoutMs: z.number().int().min(1000).max(30000).default(8000),
  concurrency: z.number().int().min(1).max(100).default(30),
})

interface FetchResult {
  url: string
  html: string
  error: string | null
  statusCode: number | null
}

function fetchUrl(rawUrl: string, timeoutMs: number): Promise<FetchResult> {
  return new Promise((resolve) => {
    let resolved = false
    const done = (result: FetchResult) => {
      if (!resolved) {
        resolved = true
        resolve(result)
      }
    }

    let parsedUrl: URL
    try {
      parsedUrl = new URL(rawUrl)
    } catch {
      return done({ url: rawUrl, html: '', error: 'invalid_url', statusCode: null })
    }

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

    const tid = setTimeout(() => done({ url: rawUrl, html: '', error: 'timeout', statusCode: null }), timeoutMs + 500)

    try {
      const req = mod.request(options, (res) => {
        // Follow redirects (max 3)
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          clearTimeout(tid)
          const redirectUrl = new URL(res.headers.location, rawUrl).toString()
          fetchUrl(redirectUrl, timeoutMs).then((r) => done({ ...r, url: rawUrl }))
          return
        }

        const chunks: Buffer[] = []
        let totalBytes = 0
        const MAX_BYTES = 500_000 // 500KB compressed limit per page

        res.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length
          if (totalBytes <= MAX_BYTES) {
            chunks.push(chunk)
          } else {
            res.destroy()
          }
        })
        res.on('end', () => {
          clearTimeout(tid)
          const rawBuf = Buffer.concat(chunks)
          const encoding = (res.headers['content-encoding'] || '').toLowerCase()
          const finish = (html: string) => done({ url: rawUrl, html, error: null, statusCode: res.statusCode ?? null })
          if (encoding === 'gzip') {
            zlib.gunzip(rawBuf, (err, decoded) => finish(err ? rawBuf.toString('utf8') : decoded.toString('utf8')))
          } else if (encoding === 'deflate') {
            zlib.inflate(rawBuf, (err, decoded) => finish(err ? rawBuf.toString('utf8') : decoded.toString('utf8')))
          } else if (encoding === 'br') {
            zlib.brotliDecompress(rawBuf, (err, decoded) => finish(err ? rawBuf.toString('utf8') : decoded.toString('utf8')))
          } else {
            finish(rawBuf.toString('utf8'))
          }
        })
        res.on('error', (e) => {
          clearTimeout(tid)
          done({ url: rawUrl, html: '', error: e.message, statusCode: null })
        })
      })

      req.on('error', (e) => {
        clearTimeout(tid)
        done({ url: rawUrl, html: '', error: e.message, statusCode: null })
      })
      req.on('timeout', () => {
        req.destroy()
        clearTimeout(tid)
        done({ url: rawUrl, html: '', error: 'socket_timeout', statusCode: null })
      })
      req.setTimeout(timeoutMs)
      req.end()
    } catch (e) {
      clearTimeout(tid)
      done({ url: rawUrl, html: '', error: String(e), statusCode: null })
    }
  })
}

async function fetchBatch(urls: string[], timeoutMs: number, concurrency: number): Promise<FetchResult[]> {
  const results: FetchResult[] = []
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency)
    const batchResults = await Promise.all(batch.map((url) => fetchUrl(url, timeoutMs)))
    results.push(...batchResults)
  }
  return results
}

export async function POST(req: NextRequest) {
  if (_activeFetches >= MAX_CONCURRENT_FETCHES) {
    return NextResponse.json(
      { success: false, error: 'Server busy — too many concurrent fetch jobs. Retry in a few seconds.' },
      { status: 429 }
    )
  }
  _activeFetches++
  try {
    const body = Schema.parse(await req.json())
    const { urls, timeoutMs, concurrency } = body

    const startMs = Date.now()
    const results = await fetchBatch(urls, timeoutMs, concurrency)
    const elapsedMs = Date.now() - startMs

    const successCount = results.filter((r) => r.error === null).length
    const errorCount = results.length - successCount

    return NextResponse.json({
      success: true,
      results,
      meta: {
        total: results.length,
        successCount,
        errorCount,
        elapsedMs,
        avgMs: Math.round(elapsedMs / Math.max(results.length, 1)),
      },
    })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  } finally {
    _activeFetches--
  }
}
