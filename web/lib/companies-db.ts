import getSql from './db'
import type { CompanyRow } from './types'

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
  importedFromSheets: boolean
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
  runIds?: string[]
  industry?: string
  area?: string
  status?: string
  formType?: string
  search?: string
  hasForm?: string
  hasPhone?: string
  hasEmail?: string
  ids?: string[]
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

const NORM_TRACKING_PARAMS = [
  'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
  'fbclid','gclid','msclkid','ref','from','_ga','_gl','yclid','twclid',
  'openqrmodal','oat_content','oat__ck',
  'skin',
  'site_code','SITE_CODE',
  'page_id',
]

export function normalizeUrl(url: string): string {
  if (!url) return ''
  const decoded = url.replace(/&amp;/gi, '&')
  try {
    const u = new URL(decoded)
    const toDelete = [...u.searchParams.keys()].filter((k) =>
      NORM_TRACKING_PARAMS.some((p) => p.toLowerCase() === k.toLowerCase())
    )
    toDelete.forEach((k) => u.searchParams.delete(k))
    const pathname = u.pathname.replace(/\/+$/, '').replace(/\/{2,}/g, '/') + (u.search || '')
    return (u.hostname + pathname).toLowerCase().replace(/^www\./, '')
  } catch {
    return decoded.toLowerCase().trim()
  }
}

function generateId(): string {
  return `cmp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// DB row → Company (snake_case → camelCase)
function rowToCompany(r: Record<string, unknown>): Company {
  return {
    id:                  r.id as string,
    name:                r.name as string,
    hpUrl:               r.hp_url as string,
    formUrl:             r.form_url as string,
    normalizedFormUrl:   r.normalized_form_url as string,
    normalizedHpUrl:     r.normalized_hp_url as string,
    phone:               r.phone as string,
    email:               r.email as string,
    address:             r.address as string,
    industry:            r.industry as string,
    area:                r.area as string,
    formType:            r.form_type as string,
    status:              r.status as string,
    notes:               r.notes as string,
    projectId:           r.project_id as string,
    runId:               r.run_id as string,
    collectedAt:         r.collected_at as string,
    importedFromSheets:  r.imported_from_sheets as boolean,
  }
}

const ALLOWED_SORT: Record<CompanySortBy, string> = {
  collectedAt: 'collected_at',
  name:        'name',
  industry:    'industry',
  area:        'area',
  status:      'status',
  formType:    'form_type',
}

export async function getCompanies(filters?: CompanyFilters): Promise<Company[]> {
  const sql = getSql()
  const sortCol = ALLOWED_SORT[filters?.sortBy ?? 'collectedAt'] ?? 'collected_at'
  const sortDir = filters?.sortDir === 'ASC' ? sql`ASC` : sql`DESC`
  const limit  = filters?.limit  ?? null
  const offset = filters?.offset ?? 0

  const rows = await sql`
    SELECT * FROM companies
    WHERE TRUE
      ${filters?.projectId ? sql`AND project_id = ${filters.projectId}` : sql``}
      ${filters?.runId     ? sql`AND run_id = ${filters.runId}` : sql``}
      ${filters?.runIds?.length ? sql`AND run_id = ANY(${filters.runIds})` : sql``}
      ${filters?.industry  ? sql`AND industry = ${filters.industry}` : sql``}
      ${filters?.area      ? sql`AND area = ${filters.area}` : sql``}
      ${filters?.status    ? sql`AND status = ${filters.status}` : sql``}
      ${filters?.formType  ? sql`AND form_type = ${filters.formType}` : sql``}
      ${filters?.search    ? sql`AND (
        LOWER(name) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(hp_url) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(form_url) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(address) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR phone LIKE ${'%' + filters.search + '%'}
        OR LOWER(email) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(notes) LIKE ${'%' + filters.search.toLowerCase() + '%'}
      )` : sql``}
      ${filters?.hasForm  === 'true'  ? sql`AND form_url != ''` : sql``}
      ${filters?.hasForm  === 'false' ? sql`AND form_url = ''`  : sql``}
      ${filters?.hasPhone === 'true'  ? sql`AND phone != ''`    : sql``}
      ${filters?.hasEmail === 'true'  ? sql`AND email != ''`    : sql``}
      ${filters?.ids?.length ? sql`AND id = ANY(${filters.ids})` : sql``}
    ORDER BY ${sql(sortCol)} ${sortDir}
    ${limit !== null ? sql`LIMIT ${limit} OFFSET ${offset}` : sql``}
  `
  return rows.map(rowToCompany)
}

export async function countCompanies(filters?: Omit<CompanyFilters, 'limit' | 'offset'>): Promise<number> {
  const sql = getSql()
  const rows = await sql`
    SELECT COUNT(*)::int as cnt FROM companies
    WHERE TRUE
      ${filters?.projectId ? sql`AND project_id = ${filters.projectId}` : sql``}
      ${filters?.runId     ? sql`AND run_id = ${filters.runId}` : sql``}
      ${filters?.runIds?.length ? sql`AND run_id = ANY(${filters.runIds})` : sql``}
      ${filters?.industry  ? sql`AND industry = ${filters.industry}` : sql``}
      ${filters?.area      ? sql`AND area = ${filters.area}` : sql``}
      ${filters?.status    ? sql`AND status = ${filters.status}` : sql``}
      ${filters?.formType  ? sql`AND form_type = ${filters.formType}` : sql``}
      ${filters?.search    ? sql`AND (
        LOWER(name) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(hp_url) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(form_url) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(address) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR phone LIKE ${'%' + filters.search + '%'}
        OR LOWER(email) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(notes) LIKE ${'%' + filters.search.toLowerCase() + '%'}
      )` : sql``}
      ${filters?.hasForm  === 'true'  ? sql`AND form_url != ''` : sql``}
      ${filters?.hasForm  === 'false' ? sql`AND form_url = ''`  : sql``}
      ${filters?.hasPhone === 'true'  ? sql`AND phone != ''`    : sql``}
      ${filters?.hasEmail === 'true'  ? sql`AND email != ''`    : sql``}
  `
  return rows[0].cnt as number
}

export async function countCompaniesAndFormCount(
  filters?: Omit<CompanyFilters, 'limit' | 'offset'>
): Promise<{ total: number; formCount: number; phoneCount: number; emailCount: number }> {
  const sql = getSql()
  const rows = await sql`
    SELECT
      COUNT(*)::int as total,
      SUM(CASE WHEN form_url  != '' THEN 1 ELSE 0 END)::int as form_count,
      SUM(CASE WHEN phone     != '' THEN 1 ELSE 0 END)::int as phone_count,
      SUM(CASE WHEN email     != '' THEN 1 ELSE 0 END)::int as email_count
    FROM companies
    WHERE TRUE
      ${filters?.projectId ? sql`AND project_id = ${filters.projectId}` : sql``}
      ${filters?.runId     ? sql`AND run_id = ${filters.runId}` : sql``}
      ${filters?.runIds?.length ? sql`AND run_id = ANY(${filters.runIds})` : sql``}
      ${filters?.industry  ? sql`AND industry = ${filters.industry}` : sql``}
      ${filters?.area      ? sql`AND area = ${filters.area}` : sql``}
      ${filters?.status    ? sql`AND status = ${filters.status}` : sql``}
      ${filters?.formType  ? sql`AND form_type = ${filters.formType}` : sql``}
      ${filters?.search    ? sql`AND (
        LOWER(name) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(hp_url) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(form_url) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(address) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR phone LIKE ${'%' + filters.search + '%'}
        OR LOWER(email) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(notes) LIKE ${'%' + filters.search.toLowerCase() + '%'}
      )` : sql``}
      ${filters?.hasForm  === 'true'  ? sql`AND form_url != ''` : sql``}
      ${filters?.hasForm  === 'false' ? sql`AND form_url = ''`  : sql``}
      ${filters?.hasPhone === 'true'  ? sql`AND phone != ''`    : sql``}
      ${filters?.hasEmail === 'true'  ? sql`AND email != ''`    : sql``}
  `
  const r = rows[0]
  return {
    total:      r.total      as number,
    formCount:  filters?.hasForm  === 'false' ? 0 : (r.form_count  as number ?? 0),
    phoneCount: filters?.hasPhone === 'false' ? 0 : (r.phone_count as number ?? 0),
    emailCount: filters?.hasEmail === 'false' ? 0 : (r.email_count as number ?? 0),
  }
}

export async function getDistinctValues(projectId?: string): Promise<{ industries: string[]; areas: string[] }> {
  const sql = getSql()
  const [indRows, areaRows] = await Promise.all([
    sql`SELECT DISTINCT industry FROM companies ${projectId ? sql`WHERE project_id = ${projectId}` : sql``} ORDER BY industry`,
    sql`SELECT DISTINCT area     FROM companies ${projectId ? sql`WHERE project_id = ${projectId}` : sql``} ORDER BY area`,
  ])
  return {
    industries: indRows.map(r => r.industry as string).filter(Boolean),
    areas:      areaRows.map(r => r.area as string).filter(Boolean),
  }
}

export async function getCompanyStats(projectId?: string): Promise<{
  total: number
  formFoundCount: number
  byStatus: Record<string, number>
  byFormType: Record<string, number>
}> {
  const sql = getSql()
  const where = projectId ? sql`WHERE project_id = ${projectId}` : sql``

  const [totalRows, statusRows, formTypeRows] = await Promise.all([
    sql`SELECT COUNT(*)::int as cnt, SUM(CASE WHEN form_url != '' THEN 1 ELSE 0 END)::int as form_found FROM companies ${where}`,
    sql`SELECT status, COUNT(*)::int as cnt FROM companies ${where} GROUP BY status`,
    sql`SELECT form_type, COUNT(*)::int as cnt FROM companies ${where} GROUP BY form_type`,
  ])

  const byStatus: Record<string, number> = {}
  for (const r of statusRows) byStatus[r.status as string || '不明'] = r.cnt as number

  const byFormType: Record<string, number> = {}
  for (const r of formTypeRows) byFormType[r.form_type as string || 'unknown'] = r.cnt as number

  return {
    total: totalRows[0].cnt as number,
    formFoundCount: totalRows[0].form_found as number,
    byStatus,
    byFormType,
  }
}

export async function getProjectsStats(projectIds: string[]): Promise<Map<string, { companyCount: number; formFoundCount: number }>> {
  if (projectIds.length === 0) return new Map()
  const sql = getSql()
  const rows = await sql`
    SELECT
      project_id,
      COUNT(*)::int as company_count,
      SUM(CASE WHEN form_url != '' THEN 1 ELSE 0 END)::int as form_found_count
    FROM companies
    WHERE project_id = ANY(${projectIds})
    GROUP BY project_id
  `
  const map = new Map<string, { companyCount: number; formFoundCount: number }>()
  for (const r of rows) map.set(r.project_id as string, { companyCount: r.company_count as number, formFoundCount: r.form_found_count as number })
  return map
}

export async function getFormUrls(): Promise<Set<string>> {
  const sql = getSql()
  const rows = await sql`SELECT normalized_form_url FROM companies WHERE normalized_form_url != ''`
  return new Set(rows.map(r => r.normalized_form_url as string))
}

async function getHpUrls(): Promise<Set<string>> {
  const sql = getSql()
  const rows = await sql`SELECT normalized_hp_url FROM companies WHERE normalized_hp_url != ''`
  return new Set(rows.map(r => r.normalized_hp_url as string))
}

export async function addCompanies(rows: CompanyInput[]): Promise<{ added: number; duplicates: number; upgraded: number }> {
  const sql = getSql()
  const [existingFormUrls, existingHpUrls] = await Promise.all([getFormUrls(), getHpUrls()])
  let added = 0, duplicates = 0, upgraded = 0

  for (const row of rows) {
    const normForm = normalizeUrl(row.formUrl || '')
    const normHp   = normalizeUrl(row.hpUrl   || '')

    if (normForm && existingFormUrls.has(normForm)) { duplicates++; continue }

    if (normHp && existingHpUrls.has(normHp)) {
      if (normForm && row.formUrl) {
        const existing = await sql`SELECT id FROM companies WHERE normalized_hp_url = ${normHp} AND form_url = '' LIMIT 1`
        if (existing.length > 0) {
          const resolvedFormType = isLineUrl(row.formUrl) ? 'LINE' : (row.formType === 'booking' ? 'reservation' : (row.formType || ''))
          await sql`
            UPDATE companies SET
              form_url = ${row.formUrl},
              normalized_form_url = ${normForm},
              phone    = CASE WHEN phone    = '' THEN ${row.phone    || ''} ELSE phone    END,
              email    = CASE WHEN email    = '' THEN ${row.email    || ''} ELSE email    END,
              address  = CASE WHEN address  = '' THEN ${row.address  || ''} ELSE address  END,
              form_type = ${resolvedFormType}
            WHERE id = ${existing[0].id as string} AND form_url = ''
          `
          existingFormUrls.add(normForm)
          upgraded++
        } else { duplicates++ }
      } else { duplicates++ }
      continue
    }

    const resolvedFormType = row.formUrl && isLineUrl(row.formUrl)
      ? 'LINE'
      : (row.formType === 'booking' ? 'reservation' : (row.formType || ''))

    await sql`
      INSERT INTO companies
        (id, name, hp_url, form_url, normalized_form_url, normalized_hp_url,
         phone, email, address, industry, area, form_type, status, notes,
         project_id, run_id, collected_at, imported_from_sheets)
      VALUES (
        ${generateId()},
        ${row.name || ''},
        ${row.hpUrl || ''},
        ${row.formUrl || ''},
        ${normForm},
        ${normHp},
        ${row.phone   || ''},
        ${row.email   || ''},
        ${row.address || ''},
        ${row.industry || ''},
        ${row.area     || ''},
        ${resolvedFormType},
        ${row.status   || '未送信'},
        ${row.notes    || ''},
        ${row.projectId || ''},
        ${row.runId     || ''},
        ${row.collectedAt || new Date().toISOString()},
        ${row.importedFromSheets ?? false}
      )
    `
    if (normForm) existingFormUrls.add(normForm)
    if (normHp)   existingHpUrls.add(normHp)
    added++
  }

  return { added, duplicates, upgraded }
}

export async function removeByRunId(runId: string): Promise<number> {
  const sql = getSql()
  const result = await sql`DELETE FROM companies WHERE run_id = ${runId}`
  return result.count
}

export async function updateCompany(id: string, updates: { status?: string; notes?: string }): Promise<boolean> {
  const sql = getSql()
  const sets: string[] = []
  if (updates.status !== undefined) sets.push(`status = '${updates.status.replace(/'/g, "''")}'`)
  if (updates.notes  !== undefined) sets.push(`notes  = '${updates.notes.replace(/'/g, "''")}'`)
  if (sets.length === 0) return false
  const result = await sql`UPDATE companies SET ${sql.unsafe(sets.join(', '))} WHERE id = ${id}`
  return result.count > 0
}

export async function batchUpdateStatus(ids: string[], status: string): Promise<number> {
  if (ids.length === 0) return 0
  const sql = getSql()
  const result = await sql`UPDATE companies SET status = ${status} WHERE id = ANY(${ids})`
  return result.count
}

export async function batchUpdateStatusByFilter(
  filters: Omit<CompanyFilters, 'limit' | 'offset' | 'ids' | 'sortBy' | 'sortDir'>,
  status: string
): Promise<number> {
  const sql = getSql()
  const result = await sql`
    UPDATE companies SET status = ${status}
    WHERE TRUE
      ${filters?.projectId ? sql`AND project_id = ${filters.projectId}` : sql``}
      ${filters?.runId     ? sql`AND run_id = ${filters.runId}` : sql``}
      ${filters?.industry  ? sql`AND industry = ${filters.industry}` : sql``}
      ${filters?.area      ? sql`AND area = ${filters.area}` : sql``}
      ${filters?.status    ? sql`AND status = ${filters.status}` : sql``}
      ${filters?.formType  ? sql`AND form_type = ${filters.formType}` : sql``}
      ${filters?.search    ? sql`AND (
        LOWER(name) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(hp_url) LIKE ${'%' + filters.search.toLowerCase() + '%'}
        OR LOWER(form_url) LIKE ${'%' + filters.search.toLowerCase() + '%'}
      )` : sql``}
      ${filters?.hasForm  === 'true'  ? sql`AND form_url != ''` : sql``}
      ${filters?.hasForm  === 'false' ? sql`AND form_url = ''`  : sql``}
      ${filters?.hasPhone === 'true'  ? sql`AND phone != ''`    : sql``}
      ${filters?.hasEmail === 'true'  ? sql`AND email != ''`    : sql``}
  `
  return result.count
}

/** @deprecated */
export async function getCompanyCount(filters?: CompanyFilters): Promise<number> {
  return countCompanies(filters)
}

export function mapSheetRowToInput(row: CompanyRow): CompanyInput {
  return {
    name:               row['会社名'],
    hpUrl:              row['HP URL'],
    formUrl:            row['フォームURL'],
    phone:              row['電話番号'],
    email:              row['メールアドレス'],
    address:            row['住所'],
    industry:           row['業種'],
    area:               row['エリア'],
    formType:           row['フォーム種別'],
    status:             row['ステータス'] || '未送信',
    notes:              row['備考'],
    projectId:          row['プロジェクトID'],
    runId:              row['実行ID'],
    collectedAt:        row['収集日時'] || new Date().toISOString(),
    importedFromSheets: true,
  }
}
