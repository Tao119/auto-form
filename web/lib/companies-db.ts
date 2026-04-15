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

export interface CompanyFilters {
  projectId?: string
  runId?: string
  industry?: string
  area?: string
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
  _db.exec(`
    CREATE TABLE IF NOT EXISTS companies (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL DEFAULT '',
      hpUrl             TEXT NOT NULL DEFAULT '',
      formUrl           TEXT NOT NULL DEFAULT '',
      normalizedFormUrl TEXT NOT NULL DEFAULT '',
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
    CREATE INDEX IF NOT EXISTS idx_companies_projectId        ON companies(projectId);
    CREATE INDEX IF NOT EXISTS idx_companies_runId            ON companies(runId);
    CREATE INDEX IF NOT EXISTS idx_companies_industry         ON companies(industry);
    CREATE INDEX IF NOT EXISTS idx_companies_area             ON companies(area);
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
  const params: Record<string, string> = {}

  if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId }
  if (filters?.runId)     { clauses.push('runId = @runId');         params.runId = filters.runId }
  if (filters?.industry)  { clauses.push('industry = @industry');   params.industry = filters.industry }
  if (filters?.area)      { clauses.push('area = @area');           params.area = filters.area }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  return db.prepare(`SELECT * FROM companies ${where} ORDER BY collectedAt DESC`).all(params) as Company[]
}

export function getFormUrls(): Set<string> {
  const db = getDb()
  const rows = db.prepare("SELECT normalizedFormUrl FROM companies WHERE normalizedFormUrl != ''").all() as { normalizedFormUrl: string }[]
  return new Set(rows.map(r => r.normalizedFormUrl))
}

export function addCompanies(rows: CompanyInput[]): { added: number; duplicates: number } {
  const db = getDb()
  const existing = getFormUrls()
  let added = 0
  let duplicates = 0

  const insert = db.prepare(`
    INSERT INTO companies
      (id, name, hpUrl, formUrl, normalizedFormUrl, phone, email, address,
       industry, area, formType, status, notes, projectId, runId, collectedAt, importedFromSheets)
    VALUES
      (@id, @name, @hpUrl, @formUrl, @normalizedFormUrl, @phone, @email, @address,
       @industry, @area, @formType, @status, @notes, @projectId, @runId, @collectedAt, @importedFromSheets)
  `)

  const addMany = db.transaction((rows: CompanyInput[]) => {
    for (const row of rows) {
      const norm = normalizeUrl(row.formUrl || '')
      if (norm && existing.has(norm)) {
        duplicates++
        continue
      }
      insert.run({
        id: generateId(),
        name: row.name || '',
        hpUrl: row.hpUrl || '',
        formUrl: row.formUrl || '',
        normalizedFormUrl: norm,
        phone: row.phone || '',
        email: row.email || '',
        address: row.address || '',
        industry: row.industry || '',
        area: row.area || '',
        formType: row.formType || '',
        status: row.status || '未送信',
        notes: row.notes || '',
        projectId: row.projectId || '',
        runId: row.runId || '',
        collectedAt: row.collectedAt || new Date().toISOString(),
        importedFromSheets: row.importedFromSheets ? 1 : 0,
      })
      if (norm) existing.add(norm)
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

export function getCompanyCount(filters?: CompanyFilters): number {
  const db = getDb()
  const clauses: string[] = []
  const params: Record<string, string> = {}

  if (filters?.projectId) { clauses.push('projectId = @projectId'); params.projectId = filters.projectId }
  if (filters?.runId)     { clauses.push('runId = @runId');         params.runId = filters.runId }
  if (filters?.industry)  { clauses.push('industry = @industry');   params.industry = filters.industry }
  if (filters?.area)      { clauses.push('area = @area');           params.area = filters.area }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const row = db.prepare(`SELECT COUNT(*) as cnt FROM companies ${where}`).get(params) as { cnt: number }
  return row.cnt
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
