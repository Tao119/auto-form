import Database from 'better-sqlite3'
import path from 'path'
import fs from 'fs'
import type { CompanyRow } from './types'

const DATA_DIR = path.join(process.cwd(), 'data')
const DB_FILE = path.join(DATA_DIR, 'companies.db')

export interface Company {
  id: string
  name: string
  hpUrl: string
  formUrl: string
  normalizedFormUrl: string
  normalizedHpUrl: string
  phone: string
  email: string
  address: string
  industry: string
  area: string
  formType: string
  status: string
  notes: string
  projectId: string
  runId: string
  collectedAt: string
  importedFromSheets: number // 0 | 1  (SQLite has no bool)
}

export interface CompanyInput {
  name: string
  hpUrl: string
  formUrl: string
  phone?: string
  email?: string
  address?: string
  industry?: string
  area?: string
  formType?: string
  status?: string
  notes?: string
  projectId?: string
  runId?: string
  collectedAt?: string
  importedFromSheets?: boolean
}

export type CompanySortBy = 'collectedAt' | 'name' | 'industry' | 'area' | 'status' | 'formType'
export type CompanySortDir = 'ASC' | 'DESC'

export interface CompanyFilters {
  projectId?: string
  runId?: string
  industry?: string
  area?: string
  status?: string
  formType?: string
  search?: string  // searches name, hpUrl, formUrl
  hasForm?: string  // 'true' = formUrl != '', 'false' = formUrl = ''
  hasPhone?: string // 'true' = phone != ''
  hasEmail?: string // 'true' = email != ''
  ids?: string[]   // filter by specific company IDs (for selective export)
  sortBy?: CompanySortBy
  sortDir?: CompanySortDir
  limit?: number
  offset?: number
}

// ── URL classification helpers ─────────────────────────────────────
const LINE_URL_PATTERNS = [
  /^https?:\/\/(www\.)?lin\.ee\//i,
  /^https?:\/\/(www\.)?page\.line\.me\//i,
  /^https?:\/\/(www\.)?accountpage\.line\.me\//i,
  /^https?:\/\/liff\.line\.me\//i,
]

export function isLineUrl(url: string): boolean {
  if (!url) return false
  return LINE_URL_PATTERNS.some(re => re.test(url))
}

// Tracking query parameters that should be stripped before URL normalization / dedup.
// Includes: standard UTM/ad tracking, LINE display params (openQrModal, oat_content),
// mypl.net skin param, and other non-identifying UI/referral params.
const NORM_TRACKING_PARAMS = [
  // Standard ad/analytics tracking
  'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
  'fbclid','gclid','msclkid','ref','from','_ga','_gl','yclid','twclid',
  // LINE URL display-only params (do not distinguish LINE accounts)
  'openqrmodal','oat_content','oat__ck',
  // mypl.net / portal skin param
  'skin',
  // Google Business Profile referral
  'site_code','SITE_CODE',
  // WordPress page ID (when used as the sole query param on a contact/form page,
  // the path already identifies the page uniquely; stripping prevents dedup misses
  // caused by inconsistent normalization across collection rounds)
  'page_id',
]

// ── URL normalization ──────────────────────────────────────────────
export function normalizeUrl(url: string): string {
  if (!url) return ''
  // Pre-process: decode HTML entities (&amp; → &) before URL parsing
  const decoded = url.replace(/&amp;/gi, '&')
  try {
    const u = new URL(decoded)
    // Strip known tracking/display query parameters before dedup comparison
    // Use case-insensitive matching since params may vary in casing across sources
    const toDelete = [...u.searchParams.keys()].filter((k) =>
      NORM_TRACKING_PARAMS.some((p) => p.toLowerCase() === k.toLowerCase())
    )
    toDelete.forEach((k) => u.searchParams.delete(k))
    // Build normalized key: host + path (strip scheme, www, trailing slash)
    const path = u.pathname.replace(/\/+$/, '').replace(/\/{2,}/g, '/') + (u.search || '')
    return (u.hostname + path).toLowerCase().replace(/^www\./, '')
  } catch {
    return decoded.toLowerCase().trim()
  }
}

// ── DB singleton ───────────────────────────────────────────────────
let _db: Database.Database | null = null

function getDb(): Database.Database {
  if (_db) return _db
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  _db = new Database(DB_FILE)
  _db.pragma('journal_mode = WAL')
  _db.pragma('synchronous = NORMAL')
  _db.pragma('wal_autocheckpoint = 400')  // checkpoint every ~1.6MB (400 * 4096 bytes)
  _db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL DEFAULT '',
      hpUrl             TEXT NOT NULL DEFAULT '',
      formUrl           TEXT NOT NULL DEFAULT '',
      normalizedFormUrl TEXT NOT NULL DEFAULT '',
      normalizedHpUrl   TEXT NOT NULL DEFAULT '',
      phone             TEXT NOT NULL DEFAULT '',
      email             TEXT NOT NULL DEFAULT '',
      address           TEXT NOT NULL DEFAULT '',
      industry          TEXT NOT NULL DEFAULT '',
      area              TEXT NOT NULL DEFAULT '',
      formType          TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT '未送信',
      notes             TEXT NOT NULL DEFAULT '',
      projectId         TEXT NOT NULL DEFAULT '',
      runId             TEXT NOT NULL DEFAULT '',
      collectedAt       TEXT NOT NULL DEFAULT '',
      importedFromSheets INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_companies_normalizedFormUrl ON companies(normalizedFormUrl);
    CREATE INDEX IF NOT EXISTS idx_companies_normalizedHpUrl   ON companies(normalizedHpUrl);
    CREATE INDEX IF NOT EXISTS idx_companies_projectId        ON companies(projectId);
    CREATE INDEX IF NOT EXISTS idx_companies_runId            ON companies(runId);
    CREATE INDEX IF NOT EXISTS idx_companies_industry         ON companies(industry);
    CREATE INDEX IF NOT EXISTS idx_companies_area             ON companies(area);
    CREATE INDEX IF NOT EXISTS idx_companies_status           ON companies(status);
    CREATE INDEX IF NOT EXISTS idx_companies_formType         ON companies(formType);
    CREATE INDEX IF NOT EXISTS idx_companies_collectedAt      ON companies(collectedAt DESC);
    CREATE INDEX IF NOT EXISTS idx_companies_formUrl_ne       ON companies(projectId, formUrl) WHERE formUrl != '';
    CREATE INDEX IF NOT EXISTS idx_companies_phone_ne         ON companies(projectId, phone)   WHERE phone  != '';
    CREATE INDEX IF NOT EXISTS idx_companies_email_ne         ON companies(projectId, email)   WHERE email  != '';
  `)
  // Migration: add normalizedHpUrl column for existing DBs (ignored if column already exists)
  try { _db.exec(`ALTER TABLE companies ADD COLUMN normalizedHpUrl TEXT NOT NULL DEFAULT ''`) } catch {}
  // Migration: add address column for existing DBs created before address extraction was added
  try { _db.exec(`ALTER TABLE companies ADD COLUMN address TEXT NOT NULL DEFAULT ''`) } catch {}
  // Populate normalizedHpUrl for rows that still have the default ''
  _db.exec(`
    UPDATE companies
    SET normalizedHpUrl = LOWER(RTRIM(
      CASE
        WHEN hpUrl LIKE 'https://www.%' THEN SUBSTR(hpUrl, 13)
        WHEN hpUrl LIKE 'http://www.%'  THEN SUBSTR(hpUrl, 12)
        WHEN hpUrl LIKE 'https://%'     THEN SUBSTR(hpUrl, 9)
        WHEN hpUrl LIKE 'http://%'      THEN SUBSTR(hpUrl, 8)
        ELSE hpUrl
      END, '/'))
    WHERE normalizedHpUrl = '' AND hpUrl != ''
  `)
  // Migration: fix formType for existing LINE URLs that were mis-classified as 'inquiry'
  _db.exec(`
    UPDATE companies
    SET formType = 'LINE'
    WHERE formType != 'LINE'
      AND (
        formUrl LIKE '%://lin.ee/%'
        OR formUrl LIKE '%://page.line.me/%'
        OR formUrl LIKE '%://accountpage.line.me/%'
        OR formUrl LIKE '%://liff.line.me/%'
      )
  `)
  // Migration: reclassify booking SaaS URLs that were mis-classified as 'inquiry'
  _db.exec(`
    UPDATE companies
    SET formType = 'reservation'
    WHERE formType = 'inquiry'
      AND (
        formUrl LIKE '%://b.hpr.jp/%'
        OR formUrl LIKE '%://riyou.jp/%'
        OR formUrl LIKE '%://stekina.com/%'
        OR formUrl LIKE '%://haisha-yoyaku.jp/%'
        OR formUrl LIKE '%://ssl.haisha-yoyaku.jp/%'
        OR formUrl LIKE '%://eparkdentist.com/%'
        OR formUrl LIKE '%dentamap.jp/%'
        OR formUrl LIKE '%://ekiten.jp/%'
        OR formUrl LIKE '%b-merit.jp%'
        OR (formUrl LIKE '%coubic.com%' AND formUrl NOT LIKE '%/contact%')
        OR (formUrl LIKE '%airrsv.net%' AND formUrl LIKE '%/calendar%')
        OR formUrl LIKE '%://epark.jp/shopinfo/%'
      )
  `)
  // Migration: reclassify recruitment/job-application forms mis-classified as 'inquiry'.
  // Targets very specific URL patterns that unambiguously indicate job-application forms
  // (e.g. /recruit/entry/, /saiyo/entry/, /career/apply/) to avoid false-positive reclassification.
  _db.exec(`
    UPDATE companies
    SET formType = 'recruitment'
    WHERE formType = 'inquiry'
      AND (
        formUrl LIKE '%/recruit/entry%'
        OR formUrl LIKE '%/recruit-entry%'
        OR formUrl LIKE '%/saiyo/entry%'
        OR formUrl LIKE '%/career/apply%'
        OR formUrl LIKE '%/careers/apply%'
        OR formUrl LIKE '%/jobs/apply%'
        OR formUrl LIKE '%/obo/%'
        OR (formUrl LIKE '%recruit%' AND formUrl LIKE '%/apply%')
      )
  `)
  // Migration: re-normalize URLs where display params leaked into normalizedFormUrl.
  // Affects LINE URLs (?openQrModal, ?oat_content) and mypl.net (?skin=) that were
  // inserted before those params were added to NORM_TRACKING_PARAMS.
  // This re-normalizes ~245 affected records and then removes the duplicates that result.
  {
    type Row = { id: string; formUrl: string; normalizedFormUrl: string }
    const stale = _db.prepare(`
      SELECT id, formUrl, normalizedFormUrl FROM companies
      WHERE normalizedFormUrl LIKE '%openqrmodal%'
         OR normalizedFormUrl LIKE '%oat_content%'
         OR normalizedFormUrl LIKE '%oat__%'
         OR normalizedFormUrl LIKE '%skin=%'
         OR normalizedFormUrl LIKE '%site_code%'
    `).all() as Row[]

    if (stale.length > 0) {
      const update = _db.prepare(`UPDATE companies SET normalizedFormUrl = ? WHERE id = ?`)
      const doUpdates = _db.transaction((rows: Row[]) => {
        for (const row of rows) {
          const newNorm = normalizeUrl(row.formUrl)
          if (newNorm !== row.normalizedFormUrl) update.run(newNorm, row.id)
        }
      })
      doUpdates(stale)

      // Remove duplicate records that now share the same normalizedFormUrl.
      // Keep the one with the earlier collectedAt (or smaller id as tiebreaker).
      _db.exec(`
        DELETE FROM companies
        WHERE id IN (
          SELECT id FROM (
            SELECT id,
                   ROW_NUMBER() OVER (
                     PARTITION BY normalizedFormUrl
                     ORDER BY COALESCE(NULLIF(collectedAt,''), '9999') ASC, id ASC
                   ) as rn
            FROM companies
            WHERE normalizedFormUrl != ''
          )
          WHERE rn > 1
        )
      `)
    }
  }
  return _db
}

function generateId(): string {
  return `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// ── Public API ────────────────────────────────────────────────────

export function getCompanies(filters?: CompanyFilters): Company[] {
  const db = getDb()
  const clauses: string[] = []
  const params: Record<string, string | number> = {}

  if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId }
  if (filters?.runId)     { clauses.push('runId = @runId');         params.runId = filters.runId }
  if (filters?.industry)  { clauses.push('industry = @industry');   params.industry = filters.industry }
  if (filters?.area)      { clauses.push('area = @area');           params.area = filters.area }
  if (filters?.status)    { clauses.push('status = @status');       params.status = filters.status }
  if (filters?.formType)  { clauses.push('formType = @formType');   params.formType = filters.formType }
  if (filters?.search) {
    const q = `%${filters.search.toLowerCase()}%`
    clauses.push('(LOWER(name) LIKE @search OR LOWER(hpUrl) LIKE @search OR LOWER(formUrl) LIKE @search OR LOWER(address) LIKE @search OR phone LIKE @search OR LOWER(email) LIKE @search OR LOWER(notes) LIKE @search)')
    params.search = q
  }
  if (filters?.hasForm === 'true')  clauses.push("formUrl != ''")
  if (filters?.hasForm === 'false') clauses.push("formUrl = ''")
  if (filters?.hasPhone === 'true') clauses.push("phone != ''")
  if (filters?.hasEmail === 'true') clauses.push("email != ''")

  // IDs filter: uses positional params since IN clause doesn't work with named params
  const idsFilter = filters?.ids?.length ? filters.ids : null

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const limitClause = filters?.limit !== undefined ? `LIMIT @limit OFFSET @offset` : ''
  if (filters?.limit !== undefined) {
    params.limit = filters.limit
    params.offset = filters.offset ?? 0
  }

  // Whitelist allowed sort columns to prevent SQL injection
  const ALLOWED_SORT: ReadonlySet<string> = new Set(['collectedAt', 'name', 'industry', 'area', 'status', 'formType'])
  const sortCol = filters?.sortBy && ALLOWED_SORT.has(filters.sortBy) ? filters.sortBy : 'collectedAt'
  const sortDir = filters?.sortDir === 'ASC' ? 'ASC' : 'DESC'

  if (idsFilter) {
    const placeholders = idsFilter.map(() => '?').join(',')
    const idsWhere = clauses.length ? `${where} AND id IN (${placeholders})` : `WHERE id IN (${placeholders})`
    return db.prepare(`SELECT * FROM companies ${idsWhere} ORDER BY ${sortCol} ${sortDir}`).all([...Object.values(params), ...idsFilter]) as Company[]
  }

  return db.prepare(`SELECT * FROM companies ${where} ORDER BY ${sortCol} ${sortDir} ${limitClause}`).all(params) as Company[]
}

export function countCompanies(filters?: Omit<CompanyFilters, 'limit' | 'offset'>): number {
  const db = getDb()
  const clauses: string[] = []
  const params: Record<string, string> = {}

  if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId }
  if (filters?.runId)     { clauses.push('runId = @runId');         params.runId = filters.runId }
  if (filters?.industry)  { clauses.push('industry = @industry');   params.industry = filters.industry }
  if (filters?.area)      { clauses.push('area = @area');           params.area = filters.area }
  if (filters?.status)    { clauses.push('status = @status');       params.status = filters.status }
  if (filters?.formType)  { clauses.push('formType = @formType');   params.formType = filters.formType }
  if (filters?.search) {
    const q = `%${filters.search.toLowerCase()}%`
    clauses.push('(LOWER(name) LIKE @search OR LOWER(hpUrl) LIKE @search OR LOWER(formUrl) LIKE @search OR LOWER(address) LIKE @search OR phone LIKE @search OR LOWER(email) LIKE @search OR LOWER(notes) LIKE @search)')
    params.search = q
  }
  if (filters?.hasForm === 'true')  clauses.push("formUrl != ''")
  if (filters?.hasForm === 'false') clauses.push("formUrl = ''")
  if (filters?.hasPhone === 'true') clauses.push("phone != ''")
  if (filters?.hasEmail === 'true') clauses.push("email != ''")

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM companies ${where}`).get(params) as { cnt: number }
  return row.cnt
}

/**
 * Single-query version of two consecutive countCompanies() calls.
 * Returns both the total row count (with all filters) and the form-found count
 * (same filters, additionally constrained to formUrl != '').
 *
 * When hasForm is 'true'  → total == formCount.
 * When hasForm is 'false' → total = count with formUrl='', formCount = 0.
 * When hasForm is unset   → one SQL pass computes both with a CASE expression.
 */
export function countCompaniesAndFormCount(
  filters?: Omit<CompanyFilters, 'limit' | 'offset'>
): { total: number; formCount: number; phoneCount: number; emailCount: number } {
  const db = getDb()
  const clauses: string[] = []
  const params: Record<string, string> = {}

  if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId }
  if (filters?.runId)     { clauses.push('runId = @runId');         params.runId = filters.runId }
  if (filters?.industry)  { clauses.push('industry = @industry');   params.industry = filters.industry }
  if (filters?.area)      { clauses.push('area = @area');           params.area = filters.area }
  if (filters?.status)    { clauses.push('status = @status');       params.status = filters.status }
  if (filters?.formType)  { clauses.push('formType = @formType');   params.formType = filters.formType }
  if (filters?.search) {
    const q = `%${filters.search.toLowerCase()}%`
    clauses.push('(LOWER(name) LIKE @search OR LOWER(hpUrl) LIKE @search OR LOWER(formUrl) LIKE @search OR LOWER(address) LIKE @search OR phone LIKE @search OR LOWER(email) LIKE @search OR LOWER(notes) LIKE @search)')
    params.search = q
  }
  if (filters?.hasForm === 'true')  clauses.push("formUrl != ''")
  if (filters?.hasForm === 'false') clauses.push("formUrl = ''")
  if (filters?.hasPhone === 'true') clauses.push("phone != ''")
  if (filters?.hasEmail === 'true') clauses.push("email != ''")

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN formUrl  != '' THEN 1 ELSE 0 END) as formCount,
      SUM(CASE WHEN phone    != '' THEN 1 ELSE 0 END) as phoneCount,
      SUM(CASE WHEN email    != '' THEN 1 ELSE 0 END) as emailCount
    FROM companies ${where}
  `).get(params) as { total: number; formCount: number; phoneCount: number; emailCount: number }

  // When hasForm filter is 'false', no row can have a form URL — formCount is always 0
  return {
    total:      row.total,
    formCount:  filters?.hasForm  === 'false' ? 0 : (row.formCount  ?? 0),
    phoneCount: filters?.hasPhone === 'false' ? 0 : (row.phoneCount ?? 0),
    emailCount: filters?.hasEmail === 'false' ? 0 : (row.emailCount ?? 0),
  }
}

/** Get distinct values for filter dropdowns, scoped to a project. */
export function getDistinctValues(projectId?: string): { industries: string[]; areas: string[] } {
  const db = getDb()
  const where = projectId ? 'WHERE projectId = @projectId' : ''
  const params = projectId ? { projectId } : {}
  const industries = (db.prepare(`SELECT DISTINCT industry FROM companies ${where} ORDER BY industry`).all(params) as {industry: string}[])
    .map(r => r.industry).filter(Boolean)
  const areas = (db.prepare(`SELECT DISTINCT area FROM companies ${where} ORDER BY area`).all(params) as {area: string}[])
    .map(r => r.area).filter(Boolean)
  return { industries, areas }
}

/**
 * Efficient aggregate stats via SQL GROUP BY — avoids loading all rows into memory.
 * Used by the dashboard to show totals without scanning every row in JS.
 */
export function getCompanyStats(projectId?: string): {
  total: number
  formFoundCount: number
  byStatus: Record<string, number>
  byFormType: Record<string, number>
} {
  const db = getDb()
  const where = projectId ? 'WHERE projectId = @projectId' : ''
  const params = projectId ? { projectId } : {}

  const totalRow = db.prepare(`SELECT COUNT(*) as cnt, SUM(CASE WHEN formUrl != '' THEN 1 ELSE 0 END) as formFound FROM companies ${where}`).get(params) as { cnt: number; formFound: number }

  const statusRows = db.prepare(`SELECT status, COUNT(*) as cnt FROM companies ${where} GROUP BY status`).all(params) as Array<{ status: string; cnt: number }>
  const formTypeRows = db.prepare(`SELECT formType, COUNT(*) as cnt FROM companies ${where} GROUP BY formType`).all(params) as Array<{ formType: string; cnt: number }>

  const byStatus: Record<string, number> = {}
  for (const r of statusRows) byStatus[r.status || '不明'] = r.cnt

  const byFormType: Record<string, number> = {}
  for (const r of formTypeRows) byFormType[r.formType || 'unknown'] = r.cnt

  return {
    total: totalRow.cnt,
    formFoundCount: totalRow.formFound,
    byStatus,
    byFormType,
  }
}

/**
 * Batch stats for multiple projects in a single SQL query.
 * Replaces N×2 countCompanies() calls in the projects list API.
 */
export function getProjectsStats(projectIds: string[]): Map<string, { companyCount: number; formFoundCount: number }> {
  if (projectIds.length === 0) return new Map()
  const db = getDb()
  const placeholders = projectIds.map(() => '?').join(',')
  const rows = db.prepare(`
    SELECT projectId,
           COUNT(*) as companyCount,
           SUM(CASE WHEN formUrl != '' THEN 1 ELSE 0 END) as formFoundCount
    FROM companies
    WHERE projectId IN (${placeholders})
    GROUP BY projectId
  `).all(projectIds) as Array<{ projectId: string; companyCount: number; formFoundCount: number }>
  const map = new Map<string, { companyCount: number; formFoundCount: number }>()
  for (const r of rows) map.set(r.projectId, { companyCount: r.companyCount, formFoundCount: r.formFoundCount })
  return map
}

export function getFormUrls(): Set<string> {
  const db = getDb()
  const rows = db.prepare("SELECT normalizedFormUrl FROM companies WHERE normalizedFormUrl != ''").all() as { normalizedFormUrl: string }[]
  return new Set(rows.map(r => r.normalizedFormUrl))
}

/** Pre-load all normalized HP URLs for duplicate checking during batch inserts. */
function getHpUrls(): Set<string> {
  const db = getDb()
  const rows = db.prepare("SELECT normalizedHpUrl FROM companies WHERE normalizedHpUrl != ''").all() as { normalizedHpUrl: string }[]
  return new Set(rows.map(r => r.normalizedHpUrl))
}

export function addCompanies(rows: CompanyInput[]): { added: number; duplicates: number; upgraded: number } {
  const db = getDb()
  const existingFormUrls = getFormUrls()
  const existingHpUrls = getHpUrls()
  let added = 0
  let duplicates = 0
  let upgraded = 0

  const insert = db.prepare(`
    INSERT INTO companies
      (id, name, hpUrl, formUrl, normalizedFormUrl, normalizedHpUrl, phone, email, address,
       industry, area, formType, status, notes, projectId, runId, collectedAt, importedFromSheets)
    VALUES
      (@id, @name, @hpUrl, @formUrl, @normalizedFormUrl, @normalizedHpUrl, @phone, @email, @address,
       @industry, @area, @formType, @status, @notes, @projectId, @runId, @collectedAt, @importedFromSheets)
  `)

  // Smart upsert: if existing record has no form URL but the new record does,
  // upgrade the existing record's scraped fields. Preserves user-edited fields (status, notes).
  const upgradeFormData = db.prepare(`
    UPDATE companies
    SET formUrl = @formUrl, normalizedFormUrl = @normForm,
        phone    = CASE WHEN phone    = '' THEN @phone    ELSE phone    END,
        email    = CASE WHEN email    = '' THEN @email    ELSE email    END,
        address  = CASE WHEN address  = '' THEN @address  ELSE address  END,
        formType = @formType
    WHERE id = @id AND formUrl = ''
  `)
  const findByHpUrl = db.prepare(`SELECT id FROM companies WHERE normalizedHpUrl = @normHp AND formUrl = '' LIMIT 1`)

  const addMany = db.transaction((rows: CompanyInput[]) => {
    for (const row of rows) {
      const normForm = normalizeUrl(row.formUrl || '')
      const normHp   = normalizeUrl(row.hpUrl || '')

      // Dedup on form URL (primary — same form = same company)
      if (normForm && existingFormUrls.has(normForm)) {
        duplicates++
        continue
      }
      // Dedup on HP URL (secondary — same website = same company, even if no form)
      if (normHp && existingHpUrls.has(normHp)) {
        // Smart upsert: if the new record has a form URL and the existing doesn't, upgrade it
        if (normForm && row.formUrl) {
          const existing = findByHpUrl.get({ normHp }) as { id: string } | undefined
          if (existing) {
            const resolvedFormType = isLineUrl(row.formUrl) ? 'LINE' : (row.formType === 'booking' ? 'reservation' : (row.formType || ''))
            upgradeFormData.run({
              id: existing.id,
              formUrl: row.formUrl,
              normForm,
              phone: row.phone || '',
              email: row.email || '',
              address: row.address || '',
              formType: resolvedFormType,
            })
            existingFormUrls.add(normForm)
            upgraded++
          } else {
            duplicates++
          }
        } else {
          duplicates++
        }
        continue
      }

      // Normalise form type:
      // - LINE messenger URLs always override to 'LINE' regardless of GPT stub classification
      // - 'booking' is the scraper-internal hint; persist as 'reservation' in the DB
      const resolvedFormType = row.formUrl && isLineUrl(row.formUrl)
        ? 'LINE'
        : (row.formType === 'booking' ? 'reservation' : (row.formType || ''))
      insert.run({
        id: generateId(),
        name: row.name || '',
        hpUrl: row.hpUrl || '',
        formUrl: row.formUrl || '',
        normalizedFormUrl: normForm,
        normalizedHpUrl: normHp,
        phone: row.phone || '',
        email: row.email || '',
        address: row.address || '',
        industry: row.industry || '',
        area: row.area || '',
        formType: resolvedFormType,
        status: row.status || '未送信',
        notes: row.notes || '',
        projectId: row.projectId || '',
        runId: row.runId || '',
        collectedAt: row.collectedAt || new Date().toISOString(),
        importedFromSheets: row.importedFromSheets ? 1 : 0,
      })
      if (normForm) existingFormUrls.add(normForm)
      if (normHp) existingHpUrls.add(normHp)
      added++
    }
  })

  addMany(rows)
  return { added, duplicates, upgraded }
}

export function removeByRunId(runId: string): number {
  const db = getDb()
  const result = db.prepare('DELETE FROM companies WHERE runId = @runId').run({ runId })
  return result.changes
}

/** Update one or more fields of a single company. Returns true if found. */
export function updateCompany(id: string, updates: { status?: string; notes?: string }): boolean {
  const db = getDb()
  const sets: string[] = []
  const params: Record<string, string> = { id }
  if (updates.status !== undefined) { sets.push('status = @status'); params.status = updates.status }
  if (updates.notes  !== undefined) { sets.push('notes = @notes');   params.notes  = updates.notes  }
  if (sets.length === 0) return false
  const result = db.prepare(`UPDATE companies SET ${sets.join(', ')} WHERE id = @id`).run(params)
  return result.changes > 0
}

/** Update status of a single company. Returns true if found. */
export function updateCompanyStatus(id: string, status: string): boolean {
  return updateCompany(id, { status })
}

/** Batch update status for multiple companies. Returns number of rows updated. */
export function batchUpdateStatus(ids: string[], status: string): number {
  if (ids.length === 0) return 0
  const db = getDb()
  const placeholders = ids.map(() => '?').join(',')
  const result = db.prepare(`UPDATE companies SET status = ? WHERE id IN (${placeholders})`).run(status, ...ids)
  return result.changes
}

/** Batch update status for all companies matching a filter (for "select all pages" UX). Returns updated count. */
export function batchUpdateStatusByFilter(
  filters: Omit<CompanyFilters, 'limit' | 'offset' | 'ids' | 'sortBy' | 'sortDir'>,
  status: string
): number {
  const db = getDb()
  const clauses: string[] = []
  const params: Record<string, string> = {}

  if (filters.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId }
  if (filters.runId)     { clauses.push('runId = @runId');         params.runId = filters.runId }
  if (filters.industry)  { clauses.push('industry = @industry');   params.industry = filters.industry }
  if (filters.area)      { clauses.push('area = @area');           params.area = filters.area }
  if (filters.status)    { clauses.push('status = @currentStatus'); params.currentStatus = filters.status }
  if (filters.formType)  { clauses.push('formType = @formType');   params.formType = filters.formType }
  if (filters.search) {
    const q = `%${filters.search.toLowerCase()}%`
    clauses.push('(LOWER(name) LIKE @search OR LOWER(hpUrl) LIKE @search OR LOWER(formUrl) LIKE @search OR LOWER(address) LIKE @search OR phone LIKE @search OR LOWER(email) LIKE @search OR LOWER(notes) LIKE @search)')
    params.search = q
  }
  if (filters.hasForm === 'true')  clauses.push("formUrl != ''")
  if (filters.hasForm === 'false') clauses.push("formUrl = ''")
  if (filters.hasPhone === 'true') clauses.push("phone != ''")
  if (filters.hasEmail === 'true') clauses.push("email != ''")

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const result = db.prepare(`UPDATE companies SET status = @newStatus ${where}`)
    .run({ ...params, newStatus: status })
  return result.changes
}

/** @deprecated Use countCompanies instead */
export function getCompanyCount(filters?: CompanyFilters): number {
  return countCompanies(filters)
}

// ── Google Sheets mapping ─────────────────────────────────────────

export function mapSheetRowToInput(row: import('./types').CompanyRow): CompanyInput {
  return {
    name:              row['会社名'],
    hpUrl:             row['HP URL'],
    formUrl:           row['フォームURL'],
    phone:             row['電話番号'],
    email:             row['メールアドレス'],
    address:           row['住所'],
    industry:          row['業種'],
    area:              row['エリア'],
    formType:          row['フォーム種別'],
    status:            row['ステータス'] || '未送信',
    notes:             row['備考'],
    projectId:         row['プロジェクトID'],
    runId:             row['実行ID'],
    collectedAt:       row['収集日時'] || new Date().toISOString(),
    importedFromSheets: true,
  }
}

// ── Legacy JSON migration (one-time import) ───────────────────────
export function migrateFromJson(): { migrated: number; skipped: number } {
  const jsonFile = path.join(DATA_DIR, 'companies.json')
  if (!fs.existsSync(jsonFile)) return { migrated: 0, skipped: 0 }

  const raw = JSON.parse(fs.readFileSync(jsonFile, 'utf-8'))
  const rows: CompanyInput[] = (raw.companies || []).map((c: Company) => ({
    name:              c.name,
    hpUrl:             c.hpUrl,
    formUrl:           c.formUrl,
    phone:             c.phone,
    email:             c.email,
    address:           c.address,
    industry:          c.industry,
    area:              c.area,
    formType:          c.formType,
    status:            c.status,
    notes:             c.notes,
    projectId:         c.projectId,
    runId:             c.runId,
    collectedAt:       c.collectedAt,
    importedFromSheets: !!c.importedFromSheets,
  }))

  const { added, duplicates } = addCompanies(rows)
  return { migrated: added, skipped: duplicates }
}
