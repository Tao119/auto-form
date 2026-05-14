import getSupabase from './db'
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

function applyFilters(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  filters?: Omit<CompanyFilters, 'sortBy' | 'sortDir' | 'limit' | 'offset'>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  if (filters?.projectId) query = query.eq('project_id', filters.projectId)
  if (filters?.runId)     query = query.eq('run_id', filters.runId)
  if (filters?.runIds?.length) query = query.in('run_id', filters.runIds)
  if (filters?.industry)  query = query.eq('industry', filters.industry)
  if (filters?.area)      query = query.eq('area', filters.area)
  if (filters?.status)    query = query.eq('status', filters.status)
  if (filters?.formType)  query = query.eq('form_type', filters.formType)
  if (filters?.ids?.length) query = query.in('id', filters.ids)
  if (filters?.hasForm === 'true')  query = query.neq('form_url', '')
  if (filters?.hasForm === 'false') query = query.eq('form_url', '')
  if (filters?.hasPhone === 'true') query = query.neq('phone', '')
  if (filters?.hasEmail === 'true') query = query.neq('email', '')
  if (filters?.search) {
    const s = filters.search.toLowerCase()
    query = query.or(
      `name.ilike.%${s}%,hp_url.ilike.%${s}%,form_url.ilike.%${s}%,address.ilike.%${s}%,phone.ilike.%${s}%,email.ilike.%${s}%,notes.ilike.%${s}%`
    )
  }
  return query
}

export async function getCompanies(filters?: CompanyFilters): Promise<Company[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  const sortCol = ALLOWED_SORT[filters?.sortBy ?? 'collectedAt'] ?? 'collected_at'
  const ascending = filters?.sortDir === 'ASC'
  const limit  = filters?.limit  ?? null
  const offset = filters?.offset ?? 0

  let query = supabase.from('companies').select('*')
  query = applyFilters(query, filters)
  query = query.order(sortCol, { ascending })
  if (limit !== null) query = query.range(offset, offset + limit - 1)

  const { data, error } = await query
  if (error) throw error
  return (data ?? []).map(rowToCompany)
}

export async function countCompanies(filters?: Omit<CompanyFilters, 'limit' | 'offset'>): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  let query = supabase.from('companies').select('id', { count: 'exact', head: true })
  query = applyFilters(query, filters)
  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}

export async function countCompaniesAndFormCount(
  filters?: Omit<CompanyFilters, 'limit' | 'offset'>
): Promise<{ total: number; formCount: number; phoneCount: number; emailCount: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any

  // Run all counts in parallel
  let baseQuery = supabase.from('companies').select('id', { count: 'exact', head: true })
  baseQuery = applyFilters(baseQuery, filters)

  let formQuery = supabase.from('companies').select('id', { count: 'exact', head: true })
  formQuery = applyFilters(formQuery, { ...filters, hasForm: 'true' })

  let phoneQuery = supabase.from('companies').select('id', { count: 'exact', head: true })
  phoneQuery = applyFilters(phoneQuery, { ...filters, hasPhone: 'true' })

  let emailQuery = supabase.from('companies').select('id', { count: 'exact', head: true })
  emailQuery = applyFilters(emailQuery, { ...filters, hasEmail: 'true' })

  const [totalResult, formResult, phoneResult, emailResult] = await Promise.all([
    baseQuery,
    formQuery,
    phoneQuery,
    emailQuery,
  ])
  if (totalResult.error) throw totalResult.error
  if (formResult.error) throw formResult.error
  if (phoneResult.error) throw phoneResult.error
  if (emailResult.error) throw emailResult.error

  return {
    total:      totalResult.count ?? 0,
    formCount:  filters?.hasForm  === 'false' ? 0 : (formResult.count  ?? 0),
    phoneCount: filters?.hasPhone === 'false' ? 0 : (phoneResult.count ?? 0),
    emailCount: filters?.hasEmail === 'false' ? 0 : (emailResult.count ?? 0),
  }
}

export async function getDistinctValues(projectId?: string): Promise<{ industries: string[]; areas: string[] }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  let indQuery = supabase.from('companies').select('industry').neq('industry', '').order('industry')
  let areaQuery = supabase.from('companies').select('area').neq('area', '').order('area')
  if (projectId) {
    indQuery  = indQuery.eq('project_id', projectId)
    areaQuery = areaQuery.eq('project_id', projectId)
  }
  const [indResult, areaResult] = await Promise.all([indQuery, areaQuery])
  if (indResult.error) throw indResult.error
  if (areaResult.error) throw areaResult.error

  const industries: string[] = [...new Set((indResult.data ?? []).map((r: Record<string, unknown>) => r.industry as string))].filter((s): s is string => Boolean(s))
  const areas: string[]      = [...new Set((areaResult.data ?? []).map((r: Record<string, unknown>) => r.area as string))].filter((s): s is string => Boolean(s))
  return { industries, areas }
}

export async function getCompanyStats(projectId?: string): Promise<{
  total: number
  formFoundCount: number
  byStatus: Record<string, number>
  byFormType: Record<string, number>
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any

  let totalQuery = supabase.from('companies').select('id', { count: 'exact', head: true })
  let formQuery  = supabase.from('companies').select('id', { count: 'exact', head: true }).neq('form_url', '')
  let statusQuery    = supabase.from('companies').select('status')
  let formTypeQuery  = supabase.from('companies').select('form_type')

  if (projectId) {
    totalQuery    = totalQuery.eq('project_id', projectId)
    formQuery     = formQuery.eq('project_id', projectId)
    statusQuery   = statusQuery.eq('project_id', projectId)
    formTypeQuery = formTypeQuery.eq('project_id', projectId)
  }

  const [totalResult, formResult, statusResult, formTypeResult] = await Promise.all([
    totalQuery,
    formQuery,
    statusQuery,
    formTypeQuery,
  ])
  if (totalResult.error) throw totalResult.error
  if (formResult.error) throw formResult.error
  if (statusResult.error) throw statusResult.error
  if (formTypeResult.error) throw formTypeResult.error

  const byStatus: Record<string, number> = {}
  for (const r of statusResult.data ?? []) {
    const key = (r as Record<string, unknown>).status as string || '不明'
    byStatus[key] = (byStatus[key] ?? 0) + 1
  }

  const byFormType: Record<string, number> = {}
  for (const r of formTypeResult.data ?? []) {
    const key = (r as Record<string, unknown>).form_type as string || 'unknown'
    byFormType[key] = (byFormType[key] ?? 0) + 1
  }

  return {
    total: totalResult.count ?? 0,
    formFoundCount: formResult.count ?? 0,
    byStatus,
    byFormType,
  }
}

export async function getProjectsStats(projectIds: string[]): Promise<Map<string, { companyCount: number; formFoundCount: number }>> {
  if (projectIds.length === 0) return new Map()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  const { data, error } = await supabase
    .from('companies')
    .select('project_id, form_url')
    .in('project_id', projectIds)
  if (error) throw error

  const map = new Map<string, { companyCount: number; formFoundCount: number }>()
  for (const r of data ?? []) {
    const pid = (r as Record<string, unknown>).project_id as string
    const formUrl = (r as Record<string, unknown>).form_url as string
    const existing = map.get(pid) ?? { companyCount: 0, formFoundCount: 0 }
    map.set(pid, {
      companyCount:  existing.companyCount + 1,
      formFoundCount: existing.formFoundCount + (formUrl ? 1 : 0),
    })
  }
  return map
}

export async function getFormUrls(): Promise<Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  const { data, error } = await supabase
    .from('companies')
    .select('normalized_form_url')
    .neq('normalized_form_url', '')
  if (error) throw error
  return new Set((data ?? []).map((r: Record<string, unknown>) => r.normalized_form_url as string))
}

async function getHpUrls(): Promise<Set<string>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  const { data, error } = await supabase
    .from('companies')
    .select('normalized_hp_url')
    .neq('normalized_hp_url', '')
  if (error) throw error
  return new Set((data ?? []).map((r: Record<string, unknown>) => r.normalized_hp_url as string))
}

export async function addCompanies(rows: CompanyInput[]): Promise<{ added: number; duplicates: number; upgraded: number }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  const [existingFormUrls, existingHpUrls] = await Promise.all([getFormUrls(), getHpUrls()])
  let added = 0, duplicates = 0, upgraded = 0

  // Separate rows into: skip (full dup), upgrade (hp exists but no form), insert (new)
  const toInsert: typeof rows = []
  const toUpgrade: Array<{ normHp: string; row: CompanyInput; normForm: string; resolvedFormType: string }> = []

  for (const row of rows) {
    const normForm = normalizeUrl(row.formUrl || '')
    const normHp   = normalizeUrl(row.hpUrl   || '')

    if (normForm && existingFormUrls.has(normForm)) { duplicates++; continue }

    if (normHp && existingHpUrls.has(normHp)) {
      if (normForm && row.formUrl) {
        const resolvedFormType = isLineUrl(row.formUrl) ? 'LINE' : (row.formType === 'booking' ? 'reservation' : (row.formType || ''))
        toUpgrade.push({ normHp, row, normForm, resolvedFormType })
        existingFormUrls.add(normForm)
      } else {
        duplicates++
      }
      continue
    }

    if (normHp) existingHpUrls.add(normHp)
    if (normForm) existingFormUrls.add(normForm)
    toInsert.push(row)
  }

  // Batch insert new companies (chunk at 200 to stay within Supabase limits)
  const CHUNK = 200
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK)
    const records = chunk.map((row) => {
      const normForm = normalizeUrl(row.formUrl || '')
      const normHp   = normalizeUrl(row.hpUrl   || '')
      const resolvedFormType = row.formUrl && isLineUrl(row.formUrl)
        ? 'LINE'
        : (row.formType === 'booking' ? 'reservation' : (row.formType || ''))
      return {
        id:                   generateId(),
        name:                 row.name || '',
        hp_url:               row.hpUrl || '',
        form_url:             row.formUrl || '',
        normalized_form_url:  normForm,
        normalized_hp_url:    normHp,
        phone:                row.phone   || '',
        email:                row.email   || '',
        address:              row.address || '',
        industry:             row.industry || '',
        area:                 row.area     || '',
        form_type:            resolvedFormType,
        status:               row.status   || '未送信',
        notes:                row.notes    || '',
        project_id:           row.projectId || '',
        run_id:               row.runId     || '',
        collected_at:         row.collectedAt || new Date().toISOString(),
        imported_from_sheets: row.importedFromSheets ?? false,
      }
    })
    const { error: insertError } = await supabase.from('companies').insert(records)
    if (insertError) throw insertError
    added += chunk.length
  }

  // Process upgrades (hp exists, adding form URL) — still sequential but rare
  for (const { normHp, row, normForm, resolvedFormType } of toUpgrade) {
    const { data: existing, error: selectError } = await supabase
      .from('companies')
      .select('id, phone, email, address')
      .eq('normalized_hp_url', normHp)
      .eq('form_url', '')
      .limit(1)
    if (selectError) throw selectError
    if (!existing || existing.length === 0) { duplicates++; continue }

    const existingId = (existing[0] as Record<string, unknown>).id as string
    const cur = existing[0] as Record<string, unknown>
    const fieldUpdates: Record<string, string> = {
      form_url: row.formUrl || '',
      normalized_form_url: normForm,
      form_type: resolvedFormType,
    }
    if (!cur.phone && row.phone) fieldUpdates.phone = row.phone
    if (!cur.email && row.email) fieldUpdates.email = row.email
    if (!cur.address && row.address) fieldUpdates.address = row.address

    const { error: updateError } = await supabase
      .from('companies')
      .update(fieldUpdates)
      .eq('id', existingId)
      .eq('form_url', '')
    if (updateError) throw updateError
    upgraded++
  }

  return { added, duplicates, upgraded }
}

export async function removeByRunId(runId: string): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  const { data, error } = await supabase
    .from('companies')
    .delete()
    .eq('run_id', runId)
    .select('id')
  if (error) throw error
  return data?.length ?? 0
}

export async function updateCompany(id: string, updates: { status?: string; notes?: string }): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  const fieldsToUpdate: Record<string, string> = {}
  if (updates.status !== undefined) fieldsToUpdate.status = updates.status
  if (updates.notes  !== undefined) fieldsToUpdate.notes  = updates.notes
  if (Object.keys(fieldsToUpdate).length === 0) return false
  const { data, error } = await supabase
    .from('companies')
    .update(fieldsToUpdate)
    .eq('id', id)
    .select('id')
  if (error) throw error
  return (data?.length ?? 0) > 0
}

export async function batchUpdateStatus(ids: string[], status: string): Promise<number> {
  if (ids.length === 0) return 0
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  const { data, error } = await supabase
    .from('companies')
    .update({ status })
    .in('id', ids)
    .select('id')
  if (error) throw error
  return data?.length ?? 0
}

export async function batchUpdateStatusByFilter(
  filters: Omit<CompanyFilters, 'limit' | 'offset' | 'ids' | 'sortBy' | 'sortDir'>,
  status: string
): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase = getSupabase() as any
  let query = supabase.from('companies').update({ status }).select('id')
  query = applyFilters(query, filters)
  const { data, error } = await query
  if (error) throw error
  return data?.length ?? 0
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
