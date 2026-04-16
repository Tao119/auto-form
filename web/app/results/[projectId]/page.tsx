'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, Download, Search, RefreshCw, X,
  CheckCircle, XCircle, Clock, Play, FolderOpen, Copy, Check,
  ChevronUp, ChevronDown, ChevronsUpDown,
} from 'lucide-react'
import type { CompanyRow, Project, ProjectRun } from '@/lib/types'

function relativeTime(iso: string): string {
  if (!iso) return '-'
  const diff = Date.now() - new Date(iso).getTime()
  if (isNaN(diff)) return iso
  const mins  = Math.floor(diff / 60_000)
  const hours = Math.floor(diff / 3_600_000)
  const days  = Math.floor(diff / 86_400_000)
  if (mins  < 1)   return 'たった今'
  if (mins  < 60)  return `${mins}分前`
  if (hours < 24)  return `${hours}時間前`
  if (days  < 7)   return `${days}日前`
  return new Date(iso).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })
}

const STATUS_OPTIONS = ['全て', '未送信', '送信済み', 'エラー', 'スキップ']
const FORM_TYPE_OPTIONS: Array<{ label: string; value: string }> = [
  { label: '種別: 全て', value: '' },
  { label: '問い合わせ', value: 'inquiry' },
  { label: '予約', value: 'booking' },
  { label: 'LINE', value: 'LINE' },
  { label: '不明', value: 'unknown' },
]

interface FilterState {
  industry: string
  area: string
  status: string
  formType: string
  hasForm: string
  search: string
}

interface Meta {
  total: number
  page: number
  limit: number
  industries: string[]
  areas: string[]
}

interface ProjectDetail extends Project {
  runs: ProjectRun[]
  totalCount?: number
  formFoundCount?: number
}

// ── localStorage helpers for filter persistence ────────────────────
function loadSavedFilters(projectId: string): Partial<FilterState & { runId: string; sortBy: string; sortDir: 'ASC' | 'DESC' }> {
  try {
    const raw = localStorage.getItem(`results_filters_${projectId}`)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function saveFilters(projectId: string, data: FilterState & { runId: string; sortBy: string; sortDir: 'ASC' | 'DESC' }) {
  try { localStorage.setItem(`results_filters_${projectId}`, JSON.stringify(data)) } catch {}
}

export default function ProjectResultsPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const router = useRouter()

  // Restore persisted state once projectId is known
  const [_filterRestored, setFilterRestored] = useState(false)

  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string>('')
  const [rows, setRows] = useState<CompanyRow[]>([])
  const [meta, setMeta] = useState<Meta>({ total: 0, page: 1, limit: 100, industries: [], areas: [] })
  const [filters, setFilters] = useState<FilterState>({ industry: '', area: '', status: '', formType: '', hasForm: '', search: '' })
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [sortBy, setSortBy] = useState<string>('collectedAt')
  const [sortDir, setSortDir] = useState<'ASC' | 'DESC'>('DESC')
  const [loading, setLoading] = useState(false)
  const [projLoading, setProjLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchUpdating, setBatchUpdating] = useState(false)
  const [batchSuccessMsg, setBatchSuccessMsg] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Restore persisted filters from localStorage on first mount
  useEffect(() => {
    if (!projectId) return
    const saved = loadSavedFilters(projectId)
    if (saved.industry !== undefined || saved.area !== undefined || saved.status !== undefined || saved.formType !== undefined || saved.hasForm !== undefined) {
      setFilters({
        industry: saved.industry ?? '',
        area: saved.area ?? '',
        status: saved.status ?? '',
        formType: saved.formType ?? '',
        hasForm: saved.hasForm ?? '',
        search: '',  // never restore search — too stale
      })
    }
    if (saved.runId !== undefined) setSelectedRunId(saved.runId)
    if (saved.sortBy) setSortBy(saved.sortBy)
    if (saved.sortDir) setSortDir(saved.sortDir)
    setFilterRestored(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  // Persist filter changes to localStorage
  useEffect(() => {
    if (!projectId || !_filterRestored) return
    saveFilters(projectId, { ...filters, runId: selectedRunId, sortBy, sortDir })
  }, [projectId, _filterRestored, filters, selectedRunId, sortBy, sortDir])

  // Keyboard shortcuts:
  //   '/'       → focus search input
  //   Escape    → deselect all rows (when not in an input)
  //   ArrowLeft → previous page
  //   ArrowRight→ next page
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA'
      if (e.key === '/' && !e.metaKey && !e.ctrlKey && !inInput) {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
      if (e.key === 'Escape' && !inInput && selectedIds.size > 0) {
        setSelectedIds(new Set())
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedIds])

  // Debounce search input to avoid hammering the API on every keystroke
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    searchDebounceRef.current = setTimeout(() => setDebouncedSearch(filters.search), 350)
    return () => { if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current) }
  }, [filters.search])

  const refreshProject = useCallback(() => {
    if (!projectId) return
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => { if (d.success) setProject(d.data) })
      .catch(() => {})
  }, [projectId])

  useEffect(() => {
    if (!projectId) return
    setProjLoading(true)
    fetch(`/api/projects/${projectId}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.success) setProject(d.data)
        else setError(d.error || 'プロジェクト取得失敗')
      })
      .catch((e) => setError(String(e)))
      .finally(() => setProjLoading(false))
  }, [projectId])


  const handleSort = useCallback((col: string) => {
    if (sortBy === col) {
      setSortDir((d) => (d === 'DESC' ? 'ASC' : 'DESC'))
    } else {
      setSortBy(col)
      setSortDir('DESC')
    }
    setPage(1)
  }, [sortBy])

  const fetchData = useCallback(async (p = 1) => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(p), limit: '100', sortBy, sortDir })
      if (selectedRunId) params.set('runId', selectedRunId)
      else params.set('projectId', projectId)
      if (filters.industry) params.set('industry', filters.industry)
      if (filters.area) params.set('area', filters.area)
      if (filters.status) params.set('status', filters.status)
      if (filters.formType) params.set('formType', filters.formType)
      if (filters.hasForm) params.set('hasForm', filters.hasForm)
      if (debouncedSearch) params.set('search', debouncedSearch)
      const res = await fetch(`/api/sheets/data?${params}`)
      const data = await res.json()
      if (data.success) {
        setRows(data.data)
        setMeta({
          total: data.total ?? 0,
          page: data.page ?? p,
          limit: data.limit ?? 100,
          industries: data.industries ?? [],
          areas: data.areas ?? [],
        })
        setPage(p)
      } else {
        setError(data.error || 'データ取得失敗')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }, [projectId, selectedRunId, filters.industry, filters.area, filters.status, filters.formType, filters.hasForm, debouncedSearch, sortBy, sortDir])

  useEffect(() => { fetchData(1) }, [fetchData])

  // ArrowLeft/Right keyboard pagination (separate effect so it can reference fetchData)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const inInput = document.activeElement?.tagName === 'INPUT' || document.activeElement?.tagName === 'TEXTAREA'
      if (inInput || e.metaKey || e.ctrlKey) return
      if (e.key === 'ArrowLeft' && page > 1) { e.preventDefault(); fetchData(page - 1) }
      if (e.key === 'ArrowRight' && page * meta.limit < meta.total) { e.preventDefault(); fetchData(page + 1) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [page, meta, fetchData])

  // Auto-refresh data while any run in this project is active
  useEffect(() => {
    if (!project) return
    const hasActiveRun = project.runs.some((r) => r.status === 'running' || r.status === 'pending')
    if (!hasActiveRun) return
    const t = setInterval(() => {
      refreshProject()
      fetchData(page)
    }, 8000)
    return () => clearInterval(t)
  }, [project, page, refreshProject, fetchData])

  const handleExport = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (selectedRunId) params.set('runId', selectedRunId)
      else params.set('projectId', projectId)
      if (filters.industry) params.set('industry', filters.industry)
      if (filters.area) params.set('area', filters.area)
      if (filters.status) params.set('status', filters.status)
      if (filters.formType) params.set('formType', filters.formType)
      if (filters.hasForm) params.set('hasForm', filters.hasForm)
      if (filters.search) params.set('search', filters.search)
      params.set('sortBy', sortBy)
      params.set('sortDir', sortDir)
      // When rows are selected, export only those IDs
      if (selectedIds.size > 0) {
        params.set('ids', Array.from(selectedIds).join(','))
      }
      const res = await fetch(`/api/sheets/export?${params}`)
      if (!res.ok) throw new Error('エクスポート失敗')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      // Use server-provided filename from Content-Disposition if available
      const cd = res.headers.get('Content-Disposition') ?? ''
      const fnMatch = cd.match(/filename\*?=(?:UTF-8'')?([^;\s]+)/)
      a.download = fnMatch ? decodeURIComponent(fnMatch[1]) : `企業リスト_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(String(e))
    } finally {
      setExporting(false)
    }
  }

  const clearFilters = () => {
    setFilters({ industry: '', area: '', status: '', formType: '', hasForm: '', search: '' })
    if (projectId) {
      try { localStorage.removeItem(`results_filters_${projectId}`) } catch {}
    }
  }
  const hasFilters = filters.industry || filters.area || filters.status || filters.formType || filters.hasForm || filters.search

  const handleBatchStatusUpdate = async (newStatus: string) => {
    if (selectedIds.size === 0) return
    setBatchUpdating(true)
    try {
      const res = await fetch('/api/companies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds), status: newStatus }),
      })
      const data = await res.json()
      if (data.success) {
        const n = selectedIds.size
        setSelectedIds(new Set())
        fetchData(page)
        setBatchSuccessMsg(`${n}件を「${newStatus}」に変更しました`)
        setTimeout(() => setBatchSuccessMsg(''), 2500)
      } else {
        setError(data.error || '更新失敗')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setBatchUpdating(false)
    }
  }

  const toggleSelectAll = () => {
    if (selectedIds.size === rows.filter((r) => r.id).length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(rows.filter((r) => r.id).map((r) => r.id!)))
    }
  }

  const toggleSelect = (id: string) => {
    const next = new Set(selectedIds)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setSelectedIds(next)
  }

  if (projLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
      </div>
    )
  }

  if (!project) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-gray-400">
        <FolderOpen className="w-10 h-10 mb-3 opacity-40" />
        <p className="text-sm">プロジェクトが見つかりません</p>
        <button onClick={() => router.push('/results')} className="mt-3 text-xs text-blue-600 hover:underline">
          プロジェクト一覧へ
        </button>
      </div>
    )
  }

  return (
    <div className="p-6 space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <button
            onClick={() => router.push('/results')}
            className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 mb-2 transition-colors"
          >
            <ArrowLeft className="w-3 h-3" />
            プロジェクト一覧
          </button>
          <div className="flex items-center gap-2">
            <FolderOpen className="w-4 h-4 text-gray-400" />
            <h1 className="text-lg font-semibold text-gray-900">{project.name}</h1>
            {project.runs.some((r) => r.status === 'running') && (
              <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border bg-blue-50 text-blue-700 border-blue-200">
                <RefreshCw className="w-2.5 h-2.5 animate-spin" /> 収集中
              </span>
            )}
          </div>
          {project.description && (
            <p className="text-sm text-gray-500 mt-0.5 ml-6">{project.description}</p>
          )}
          <div className="flex items-center gap-3 mt-1 ml-6">
            <span className="text-xs text-gray-400">{project.runs.length}回の実行 · {project.id}</span>
            {project.totalCount !== undefined && project.totalCount > 0 && (
              <>
                <span className="text-gray-200">|</span>
                <span className="text-xs text-gray-500">
                  <span className="font-medium text-gray-700">{project.totalCount.toLocaleString()}</span>件収集
                </span>
                {project.formFoundCount !== undefined && (
                  <span className="text-xs text-gray-500">
                    フォームあり&nbsp;
                    <span className="font-medium text-green-600">{project.formFoundCount.toLocaleString()}</span>件
                    &nbsp;({Math.round((project.formFoundCount / project.totalCount) * 100)}%)
                  </span>
                )}
              </>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => fetchData(page)}
            disabled={loading}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-2 py-1.5 transition-colors disabled:opacity-50 bg-white"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            更新
          </button>
          <button
            onClick={handleExport}
            disabled={exporting || loading}
            className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded px-3 py-1.5 transition-colors"
          >
            <Download className="w-3 h-3" />
            {exporting ? 'エクスポート中...' : selectedIds.size > 0 ? `選択(${selectedIds.size})をCSV出力` : 'CSV出力'}
          </button>
        </div>
      </div>

      {/* Run selector */}
      {project.runs.length > 0 && (
        <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
          <div className="flex items-center gap-2 overflow-x-auto pb-1">
            <button
              onClick={() => setSelectedRunId('')}
              className={`flex-shrink-0 text-xs px-3 py-1.5 rounded border transition-colors ${
                selectedRunId === ''
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-800 bg-white'
              }`}
            >
              全ての実行
            </button>
            {project.runs.map((run) => (
              <button
                key={run.id}
                onClick={() => setSelectedRunId(run.id)}
                className={`flex-shrink-0 flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border transition-colors ${
                  selectedRunId === run.id
                    ? 'bg-blue-600 border-blue-600 text-white'
                    : 'border-gray-300 text-gray-600 hover:border-gray-400 hover:text-gray-800 bg-white'
                }`}
              >
                <RunStatusDot status={run.status} />
                <span className="truncate max-w-[160px]">{run.label}</span>
                {run.itemsWritten !== undefined && (
                  <span className="text-xs opacity-70">({run.itemsWritten}件)</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded border border-gray-200 p-3 shadow-sm">
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="md:col-span-1 relative">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              ref={searchInputRef}
              placeholder="会社名・URL・住所・電話検索... [/]"
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Escape') { setFilters({ ...filters, search: '' }); searchInputRef.current?.blur() } }}
              className="w-full bg-white border border-gray-300 rounded pl-8 pr-3 py-2 text-sm text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:outline-none"
            />
          </div>
          <select
            value={filters.industry}
            onChange={(e) => setFilters({ ...filters, industry: e.target.value })}
            className="bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
          >
            <option value="">業種: 全て</option>
            {meta.industries.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
          <select
            value={filters.area}
            onChange={(e) => setFilters({ ...filters, area: e.target.value })}
            className="bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
          >
            <option value="">エリア: 全て</option>
            {meta.areas.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select
            value={filters.formType}
            onChange={(e) => setFilters({ ...filters, formType: e.target.value })}
            className="bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
          >
            {FORM_TYPE_OPTIONS.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            className="bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s === '全て' ? '' : s}>
                {s === '全て' ? 'ステータス: 全て' : s}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-1">
            {/* hasForm quick toggle buttons */}
            {(['', 'true', 'false'] as const).map((val) => {
              const label = val === '' ? 'フォーム:全て' : val === 'true' ? 'あり' : 'なし'
              const active = filters.hasForm === val
              return (
                <button
                  key={val}
                  onClick={() => setFilters({ ...filters, hasForm: val })}
                  className={`text-xs px-2.5 py-2 rounded border transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-blue-600 border-blue-600 text-white'
                      : 'bg-white border-gray-300 text-gray-600 hover:border-gray-400'
                  }`}
                >
                  {label}
                </button>
              )
            })}
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="ml-1 p-2 text-gray-400 hover:text-gray-600 border border-gray-300 rounded transition-colors bg-white"
                title="フィルターをクリア"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Count + batch actions */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{loading ? '読み込み中...' : `${meta.total.toLocaleString()}件`}</span>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-gray-600 font-medium">{selectedIds.size}件選択</span>
              <button
                onClick={() => handleBatchStatusUpdate('送信済み')}
                disabled={batchUpdating}
                className="text-xs px-2 py-1 bg-green-600 hover:bg-green-700 disabled:bg-gray-300 text-white rounded transition-colors"
              >
                送信済みにする
              </button>
              <button
                onClick={() => handleBatchStatusUpdate('スキップ')}
                disabled={batchUpdating}
                className="text-xs px-2 py-1 bg-yellow-600 hover:bg-yellow-700 disabled:bg-gray-300 text-white rounded transition-colors"
              >
                スキップ
              </button>
              <button
                onClick={() => handleBatchStatusUpdate('未送信')}
                disabled={batchUpdating}
                className="text-xs px-2 py-1 border border-gray-300 text-gray-600 hover:bg-gray-50 rounded transition-colors"
              >
                未送信に戻す
              </button>
              <CopyFormUrlsButton ids={selectedIds} rows={rows} />
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-gray-400 hover:text-gray-600"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {!loading && meta.total > 0 && (
            <span className="text-gray-400">
              p.{page} / {Math.ceil(meta.total / meta.limit)}
            </span>
          )}
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {batchSuccessMsg && (
        <div className="bg-green-50 border border-green-200 rounded p-2 text-xs text-green-700">
          {batchSuccessMsg}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 bg-white rounded border border-gray-200 shadow-sm overflow-hidden flex flex-col min-h-0">
        <div className="overflow-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="px-3 py-3 w-8">
                  <input
                    type="checkbox"
                    checked={rows.filter((r) => r.id).length > 0 && selectedIds.size === rows.filter((r) => r.id).length}
                    onChange={toggleSelectAll}
                    className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                </th>
                <SortableHeader label="会社名" column="name" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="業種" column="industry" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="エリア" column="area" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">HP URL</th>
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">フォームURL</th>
                <SortableHeader label="フォーム種別" column="formType" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <SortableHeader label="ステータス" column="status" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">備考</th>
                <SortableHeader label="収集日時" column="collectedAt" sortBy={sortBy} sortDir={sortDir} onSort={handleSort} />
                {!selectedRunId && (
                  <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">実行</th>
                )}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                    読み込み中...
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={10} className="px-4 py-12 text-center text-gray-400">
                    データがありません
                  </td>
                </tr>
              )}
              {rows.map((row, i) => {
                const run = project.runs.find((r) => r.id === row['実行ID'])
                const isSelected = row.id ? selectedIds.has(row.id) : false
                const noForm = !row['フォームURL']
                return (
                  <tr
                    key={i}
                    onClick={(e) => {
                      if (!row.id) return
                      const t = e.target as HTMLElement
                      if (t.closest('a, button, input, select, textarea, label')) return
                      toggleSelect(row.id!)
                    }}
                    className={`border-b border-gray-100 transition-colors cursor-pointer ${
                      isSelected ? 'bg-blue-50/60 hover:bg-blue-100/60' : noForm ? 'opacity-60 hover:opacity-80 hover:bg-gray-50' : i % 2 === 0 ? 'bg-white hover:bg-gray-50' : 'bg-gray-50/50 hover:bg-gray-100/50'
                    }`}
                  >
                    <td className="px-3 py-2.5">
                      {row.id && (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggleSelect(row.id!)}
                          className="w-3.5 h-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                      )}
                    </td>
                    <td className="px-3 py-2.5 max-w-[180px]">
                      <div
                        className="font-medium text-gray-800 truncate"
                        title={[row['会社名'], row['住所']].filter(Boolean).join('\n')}
                      >
                        {row['会社名'] || '-'}
                      </div>
                      {row['電話番号'] && (
                        <div className="text-xs text-gray-400 mt-0.5 truncate">{row['電話番号']}</div>
                      )}
                      {row['メールアドレス'] && (
                        <div className="text-xs text-blue-400 mt-0.5 truncate" title={row['メールアドレス']}>
                          <a href={`mailto:${row['メールアドレス']}`} onClick={(e) => e.stopPropagation()}>
                            {row['メールアドレス']}
                          </a>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{row['業種'] || '-'}</td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{row['エリア'] || '-'}</td>
                    <td className="px-3 py-2.5 max-w-[200px]">
                      {row['HP URL'] ? (
                        <div className="flex items-center group">
                          <a href={row['HP URL']} target="_blank" rel="noreferrer"
                            className="text-blue-600 hover:text-blue-800 truncate text-xs"
                            title={row['HP URL']}>
                            {row['HP URL'].replace(/^https?:\/\//, '').slice(0, 35)}
                          </a>
                          <CopyButton text={row['HP URL']} />
                        </div>
                      ) : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2.5 max-w-[200px]">
                      {row['フォームURL'] ? (
                        <div className="flex items-center group">
                          <a href={row['フォームURL']} target="_blank" rel="noreferrer"
                            className={`truncate text-xs ${
                              row['フォーム種別'] === 'LINE'
                                ? 'text-orange-600 hover:text-orange-800'
                                : row['フォーム種別'] === 'booking'
                                ? 'text-purple-600 hover:text-purple-800'
                                : 'text-green-700 hover:text-green-900'
                            }`}
                            title={row['フォームURL']}>
                            {(() => {
                              try {
                                const u = new URL(row['フォームURL'])
                                const host = u.hostname.replace(/^www\./, '')
                                const path = u.pathname.replace(/\/+$/, '') || ''
                                const short = path.length > 20 ? path.slice(0, 20) + '…' : path
                                return host + short
                              } catch { return row['フォームURL'].replace(/^https?:\/\//, '').slice(0, 35) }
                            })()}
                          </a>
                          <CopyButton text={row['フォームURL']} />
                        </div>
                      ) : (
                        <span className="text-xs text-amber-500 italic">未検出</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 whitespace-nowrap text-xs">
                      <FormTypeBadge type={row['フォーム種別']} />
                    </td>
                    <td className="px-3 py-2.5">
                      {row.id ? (
                        <InlineStatusSelect
                          id={row.id}
                          status={row['ステータス']}
                          onChanged={() => fetchData(page)}
                        />
                      ) : (
                        <StatusBadge status={row['ステータス']} />
                      )}
                    </td>
                    <td className="px-3 py-2.5 max-w-[160px]">
                      {row.id ? (
                        <InlineNotesInput
                          id={row.id}
                          notes={row['備考'] || ''}
                        />
                      ) : (
                        <span className="text-gray-400 text-xs">{row['備考'] || '-'}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-gray-400 text-xs whitespace-nowrap" title={row['収集日時'] || ''}>{row['収集日時'] ? relativeTime(row['収集日時']) : '-'}</td>
                    {!selectedRunId && (
                      <td className="px-3 py-2.5 text-gray-400 text-xs whitespace-nowrap max-w-[120px] truncate" title={run?.label}>
                        {run?.label || row['実行ID'] || '-'}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {meta.total > meta.limit && (
          <div className="border-t border-gray-200 px-4 py-3 flex items-center justify-between bg-gray-50">
            <span className="text-xs text-gray-500">
              {((page - 1) * meta.limit) + 1}–{Math.min(page * meta.limit, meta.total)} / {meta.total}件
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => fetchData(page - 1)}
                disabled={page <= 1 || loading}
                className="text-xs px-3 py-1 border border-gray-300 rounded text-gray-600 hover:bg-white disabled:opacity-40 transition-colors"
              >
                前へ
              </button>
              <button
                onClick={() => fetchData(page + 1)}
                disabled={page * meta.limit >= meta.total || loading}
                className="text-xs px-3 py-1 border border-gray-300 rounded text-gray-600 hover:bg-white disabled:opacity-40 transition-colors"
              >
                次へ
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function InlineNotesInput({ id, notes }: { id: string; notes: string }) {
  const [value, setValue] = useState(notes)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirty] = useState(false)

  // Sync when parent refreshes data (but not while user is editing)
  useEffect(() => {
    if (!dirty) setValue(notes)
  }, [notes, dirty])

  const handleBlur = async () => {
    if (!dirty) return
    setSaving(true)
    try {
      await fetch('/api/companies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, notes: value }),
      })
      setDirty(false)
    } catch { /* ignore */ } finally {
      setSaving(false)
    }
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => { setValue(e.target.value); setDirty(true) }}
      onBlur={handleBlur}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }}
      placeholder="備考..."
      maxLength={500}
      className={`w-full text-xs px-1.5 py-0.5 rounded border transition-colors focus:outline-none ${
        saving
          ? 'border-blue-300 bg-blue-50 text-blue-700'
          : dirty
          ? 'border-amber-300 bg-amber-50 text-gray-700'
          : 'border-transparent bg-transparent text-gray-500 hover:border-gray-300 hover:bg-white focus:border-blue-400 focus:bg-white'
      }`}
    />
  )
}

function SortableHeader({
  label, column, sortBy, sortDir, onSort,
}: {
  label: string
  column: string
  sortBy: string
  sortDir: 'ASC' | 'DESC'
  onSort: (col: string) => void
}) {
  const active = sortBy === column
  return (
    <th
      className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap cursor-pointer select-none hover:text-gray-800 hover:bg-gray-100 transition-colors"
      onClick={() => onSort(column)}
    >
      <div className="flex items-center gap-1">
        {label}
        {active
          ? (sortDir === 'ASC' ? <ChevronUp className="w-3 h-3 text-blue-600" /> : <ChevronDown className="w-3 h-3 text-blue-600" />)
          : <ChevronsUpDown className="w-3 h-3 opacity-30" />
        }
      </div>
    </th>
  )
}

function CopyFormUrlsButton({ ids, rows }: { ids: Set<string>; rows: CompanyRow[] }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = () => {
    const urls = rows
      .filter((r) => r.id && ids.has(r.id) && r['フォームURL'])
      .map((r) => r['フォームURL'])
    if (urls.length === 0) return
    navigator.clipboard.writeText(urls.join('\n')).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <button
      onClick={handleCopy}
      className="flex items-center gap-1 text-xs px-2 py-1 border border-gray-300 text-gray-600 hover:bg-gray-50 rounded transition-colors"
      title="選択行のフォームURLをクリップボードにコピー"
    >
      {copied ? <Check className="w-3 h-3 text-green-600" /> : <Copy className="w-3 h-3" />}
      URL一括コピー
    </button>
  )
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    }).catch(() => {})
  }
  return (
    <button
      onClick={handleCopy}
      className="ml-1 opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded text-gray-400 hover:text-gray-700 flex-shrink-0"
      title="URLをコピー"
    >
      {copied
        ? <Check className="w-3 h-3 text-green-600" />
        : <Copy className="w-3 h-3" />
      }
    </button>
  )
}

function RunStatusDot({ status }: { status: ProjectRun['status'] }) {
  if (status === 'success' || status === 'completed') return <CheckCircle className="w-3 h-3 text-green-600" />
  if (status === 'error') return <XCircle className="w-3 h-3 text-red-500" />
  if (status === 'running') return <Play className="w-3 h-3 text-blue-500" />
  return <Clock className="w-3 h-3 text-gray-400" />
}

function FormTypeBadge({ type }: { type: string }) {
  if (type === 'LINE') {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs border bg-orange-50 text-orange-700 border-orange-300">
        LINE
      </span>
    )
  }
  if (type === 'inquiry') {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs border bg-blue-50 text-blue-700 border-blue-300">
        問い合わせ
      </span>
    )
  }
  if (type === 'booking') {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs border bg-purple-50 text-purple-700 border-purple-300">
        予約
      </span>
    )
  }
  if (type === 'unknown') {
    return (
      <span className="inline-block px-2 py-0.5 rounded text-xs border bg-gray-50 text-gray-500 border-gray-300">
        不明
      </span>
    )
  }
  return <span className="text-gray-400 text-xs">{type || '-'}</span>
}

function InlineStatusSelect({ id, status, onChanged }: { id: string; status: string; onChanged: () => void }) {
  const [updating, setUpdating] = useState(false)

  const handleChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newStatus = e.target.value
    if (newStatus === status) return
    setUpdating(true)
    try {
      const res = await fetch('/api/companies', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, status: newStatus }),
      })
      if (res.ok) onChanged()
    } catch { /* ignore */ } finally {
      setUpdating(false)
    }
  }

  const colorMap: Record<string, string> = {
    '未送信': 'bg-gray-100 text-gray-600 border-gray-300',
    '送信済み': 'bg-green-50 text-green-700 border-green-300',
    'エラー': 'bg-red-50 text-red-700 border-red-300',
    'スキップ': 'bg-yellow-50 text-yellow-700 border-yellow-300',
  }
  const cls = colorMap[status] || 'bg-gray-100 text-gray-600 border-gray-300'

  return (
    <select
      value={status}
      onChange={handleChange}
      disabled={updating}
      className={`text-xs px-2 py-0.5 rounded border cursor-pointer appearance-none ${cls} disabled:opacity-60 focus:outline-none focus:ring-1 focus:ring-blue-400`}
    >
      {['未送信', '送信済み', 'エラー', 'スキップ'].map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  )
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    '未送信': 'bg-gray-100 text-gray-600 border-gray-300',
    '送信済み': 'bg-green-50 text-green-700 border-green-300',
    'エラー': 'bg-red-50 text-red-700 border-red-300',
    'スキップ': 'bg-yellow-50 text-yellow-700 border-yellow-300',
  }
  const cls = map[status] || 'bg-gray-100 text-gray-600 border-gray-300'
  return (
    <span className={`inline-block px-2 py-0.5 rounded text-xs border ${cls}`}>
      {status || '-'}
    </span>
  )
}
