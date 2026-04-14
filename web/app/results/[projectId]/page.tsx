'use client'

import { useState, useEffect, useCallback } from 'react'
import { useParams, useRouter } from 'next/navigation'
import {
  ArrowLeft, Download, Search, RefreshCw, X,
  CheckCircle, XCircle, Clock, Play, FolderOpen
} from 'lucide-react'
import type { CompanyRow, Project, ProjectRun } from '@/lib/types'

const STATUS_OPTIONS = ['全て', '未送信', '送信済み', 'エラー', 'スキップ']

interface FilterState {
  industry: string
  area: string
  status: string
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
}

export default function ProjectResultsPage() {
  const { projectId } = useParams<{ projectId: string }>()
  const router = useRouter()

  const [project, setProject] = useState<ProjectDetail | null>(null)
  const [selectedRunId, setSelectedRunId] = useState<string>('')
  const [rows, setRows] = useState<CompanyRow[]>([])
  const [meta, setMeta] = useState<Meta>({ total: 0, page: 1, limit: 100, industries: [], areas: [] })
  const [filters, setFilters] = useState<FilterState>({ industry: '', area: '', status: '', search: '' })
  const [loading, setLoading] = useState(false)
  const [projLoading, setProjLoading] = useState(true)
  const [error, setError] = useState('')
  const [page, setPage] = useState(1)
  const [exporting, setExporting] = useState(false)

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

  const fetchData = useCallback(async (p = 1) => {
    if (!projectId) return
    setLoading(true)
    setError('')
    try {
      const params = new URLSearchParams({ page: String(p), limit: '100' })
      if (selectedRunId) params.set('runId', selectedRunId)
      else params.set('projectId', projectId)
      if (filters.industry) params.set('industry', filters.industry)
      if (filters.area) params.set('area', filters.area)
      if (filters.status) params.set('status', filters.status)
      if (filters.search) params.set('search', filters.search)
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
  }, [projectId, selectedRunId, filters])

  useEffect(() => { fetchData(1) }, [fetchData])

  const handleExport = async () => {
    setExporting(true)
    try {
      const params = new URLSearchParams()
      if (selectedRunId) params.set('runId', selectedRunId)
      else params.set('projectId', projectId)
      if (filters.industry) params.set('industry', filters.industry)
      if (filters.area) params.set('area', filters.area)
      if (filters.status) params.set('status', filters.status)
      const res = await fetch(`/api/sheets/export?${params}`)
      if (!res.ok) throw new Error('エクスポート失敗')
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `企業リスト_${new Date().toISOString().slice(0, 10)}.csv`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      setError(String(e))
    } finally {
      setExporting(false)
    }
  }

  const clearFilters = () => setFilters({ industry: '', area: '', status: '', search: '' })
  const hasFilters = filters.industry || filters.area || filters.status || filters.search

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
          </div>
          {project.description && (
            <p className="text-sm text-gray-500 mt-0.5 ml-6">{project.description}</p>
          )}
          <p className="text-xs text-gray-400 mt-1 ml-6">
            {project.runs.length}回の実行 · {project.id}
          </p>
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
            {exporting ? 'エクスポート中...' : 'CSV出力'}
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="md:col-span-1 relative">
            <Search className="absolute left-2.5 top-2.5 w-3.5 h-3.5 text-gray-400" />
            <input
              type="text"
              placeholder="会社名・URL検索..."
              value={filters.search}
              onChange={(e) => setFilters({ ...filters, search: e.target.value })}
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
          <div className="flex gap-2">
            <select
              value={filters.status}
              onChange={(e) => setFilters({ ...filters, status: e.target.value })}
              className="flex-1 bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
            >
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s === '全て' ? '' : s}>
                  {s === '全て' ? 'ステータス: 全て' : s}
                </option>
              ))}
            </select>
            {hasFilters && (
              <button
                onClick={clearFilters}
                className="p-2 text-gray-400 hover:text-gray-600 border border-gray-300 rounded transition-colors bg-white"
                title="フィルターをクリア"
              >
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Count */}
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{loading ? '読み込み中...' : `${meta.total.toLocaleString()}件`}</span>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Table */}
      <div className="flex-1 bg-white rounded border border-gray-200 shadow-sm overflow-hidden flex flex-col min-h-0">
        <div className="overflow-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">会社名</th>
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">業種</th>
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">エリア</th>
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">HP URL</th>
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">フォームURL</th>
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">フォーム種別</th>
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">ステータス</th>
                <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">収集日時</th>
                {!selectedRunId && (
                  <th className="text-left px-3 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">実行</th>
                )}
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                    読み込み中...
                  </td>
                </tr>
              )}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-gray-400">
                    データがありません
                  </td>
                </tr>
              )}
              {rows.map((row, i) => {
                const run = project.runs.find((r) => r.id === row['実行ID'])
                return (
                  <tr
                    key={i}
                    className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}
                  >
                    <td className="px-3 py-2.5 text-gray-800 font-medium max-w-[160px] truncate" title={row['会社名']}>
                      {row['会社名'] || '-'}
                    </td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{row['業種'] || '-'}</td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap">{row['エリア'] || '-'}</td>
                    <td className="px-3 py-2.5 max-w-[180px]">
                      {row['HP URL'] ? (
                        <a href={row['HP URL']} target="_blank" rel="noreferrer"
                          className="text-blue-600 hover:text-blue-800 truncate block text-xs"
                          title={row['HP URL']}>
                          {row['HP URL'].replace(/^https?:\/\//, '').slice(0, 35)}
                        </a>
                      ) : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2.5 max-w-[180px]">
                      {row['フォームURL'] ? (
                        <a href={row['フォームURL']} target="_blank" rel="noreferrer"
                          className="text-green-700 hover:text-green-900 truncate block text-xs"
                          title={row['フォームURL']}>
                          {row['フォームURL'].replace(/^https?:\/\//, '').slice(0, 35)}
                        </a>
                      ) : <span className="text-gray-400">-</span>}
                    </td>
                    <td className="px-3 py-2.5 text-gray-600 whitespace-nowrap text-xs">{row['フォーム種別'] || '-'}</td>
                    <td className="px-3 py-2.5">
                      <StatusBadge status={row['ステータス']} />
                    </td>
                    <td className="px-3 py-2.5 text-gray-400 text-xs whitespace-nowrap">{row['収集日時'] || '-'}</td>
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

function RunStatusDot({ status }: { status: ProjectRun['status'] }) {
  if (status === 'success') return <CheckCircle className="w-3 h-3 text-green-600" />
  if (status === 'error') return <XCircle className="w-3 h-3 text-red-500" />
  if (status === 'running') return <Play className="w-3 h-3 text-blue-500" />
  return <Clock className="w-3 h-3 text-gray-400" />
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
