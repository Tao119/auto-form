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
  hasForm?: string // 'true' = formUrl != '', 'false' = formUrl = ''
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

// ── URL normalization ──────────────────────────────────────────────
export function normalizeUrl(url: string): string {
  if (!url) return ''
  try {
    const u = new URL(url)
    return (u.hostname + u.pathname)
      .toLowerCase()
      .replace(/^www\./, '')
      .replace(/\/+$/, '')
      .replace(/\/{2,}/g, '/')
  } catch {
    return url.toLowerCase().trim()
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
  `)
  // Migration: add normalizedHpUrl column for existing DBs (ignored if column already exists)
  try { _db.exec(`ALTER TABLE companies ADD COLUMN normalizedHpUrl TEXT NOT NULL DEFAULT ''`) } catch {}
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
    clauses.push('(LOWER(name) LIKE @search OR LOWER(hpUrl) LIKE @search OR LOWER(formUrl) LIKE @search OR LOWER(address) LIKE @search OR phone LIKE @search)')
    params.search = q
  }
  if (filters?.hasForm === 'true')  clauses.push("formUrl != ''")
  if (filters?.hasForm === 'false') clauses.push("formUrl = ''")

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
    clauses.push('(LOWER(name) LIKE @search OR LOWER(hpUrl) LIKE @search OR LOWER(formUrl) LIKE @search OR LOWER(address) LIKE @search OR phone LIKE @search)')
    params.search = q
  }
  if (filters?.hasForm === 'true')  clauses.push("formUrl != ''")
  if (filters?.hasForm === 'false') clauses.push("formUrl = ''")

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM companies ${where}`).get(params) as { cnt: number }
  return row.cnt
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

export function addCompanies(rows: CompanyInput[]): { added: number; duplicates: number } {
  const db = getDb()
  const existingFormUrls = getFormUrls()
  const existingHpUrls = getHpUrls()
  let added = 0
  let duplicates = 0

  const insert = db.prepare(`
    INSERT INTO companies
      (id, name, hpUrl, formUrl, normalizedFormUrl, normalizedHpUrl, phone, email, address,
       industry, area, formType, status, notes, projectId, runId, collectedAt, importedFromSheets)
    VALUES
      (@id, @name, @hpUrl, @formUrl, @normalizedFormUrl, @normalizedHpUrl, @phone, @email, @address,
       @industry, @area, @formType, @status, @notes, @projectId, @runId, @collectedAt, @importedFromSheets)
  `)

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
        duplicates++
        continue
      }

      // Override GPT stub classification for LINE messenger links
      const resolvedFormType = row.formUrl && isLineUrl(row.formUrl)
        ? 'LINE'
        : (row.formType || '')
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
  return { added, duplicates }
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
