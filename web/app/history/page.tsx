'use client'

import { useState, useEffect, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import {
  CheckCircle2, XCircle, Clock, AlertCircle, RefreshCw,
  FolderOpen, ChevronRight, Play, Database, Zap, DollarSign, ListOrdered,
  Search, Filter, Trash2,
} from 'lucide-react'
import type { ProjectRun } from '@/lib/types'

interface RunWithProject extends ProjectRun {
  projectName: string
}

function StatusBadge({ status }: { status: ProjectRun['status'] }) {
  const map: Record<string, { label: string; cls: string; icon: React.ReactNode }> = {
    success:   { label: '成功', cls: 'bg-green-50 text-green-700 border-green-300', icon: <CheckCircle2 className="w-3 h-3" /> },
    completed: { label: '完了', cls: 'bg-green-50 text-green-700 border-green-300', icon: <CheckCircle2 className="w-3 h-3" /> },
    error:     { label: 'エラー', cls: 'bg-red-50 text-red-700 border-red-300', icon: <XCircle className="w-3 h-3" /> },
    running:   { label: '実行中', cls: 'bg-blue-50 text-blue-700 border-blue-300', icon: <Clock className="w-3 h-3 animate-spin" /> },
    pending:   { label: '待機中', cls: 'bg-yellow-50 text-yellow-700 border-yellow-300', icon: <AlertCircle className="w-3 h-3" /> },
    canceled:  { label: 'キャンセル', cls: 'bg-gray-100 text-gray-600 border-gray-300', icon: <XCircle className="w-3 h-3" /> },
  }
  const s = map[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600 border-gray-300', icon: null }
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${s.cls}`}>
      {s.icon} {s.label}
    </span>
  )
}

function formatDuration(createdAt: string, completedAt?: string): string {
  if (!completedAt) return '-'
  const ms = new Date(completedAt).getTime() - new Date(createdAt).getTime()
  if (ms < 0) return '-'
  const secs = Math.floor(ms / 1000)
  const mins = Math.floor(secs / 60)
  const hours = Math.floor(mins / 60)
  if (hours > 0) return `${hours}時間${mins % 60}分`
  return `${mins}分${secs % 60}秒`
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'たった今'
  if (min < 60) return `${min}分前`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}時間前`
  const d = Math.floor(h / 24)
  return `${d}日前`
}

const STATUS_OPTIONS = [
  { value: '', label: 'すべて' },
  { value: 'running', label: '実行中' },
  { value: 'pending', label: '待機中' },
  { value: 'success', label: '成功' },
  { value: 'completed', label: '完了' },
  { value: 'error', label: 'エラー' },
]

export default function HistoryPage() {
  const router = useRouter()
  const [runs, setRuns] = useState<RunWithProject[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      await fetch('/api/projects/runs/sync', { method: 'POST' }).catch(() => {})
      const res = await fetch('/api/projects/runs')
      const data = await res.json()
      if (data.success) setRuns([...data.data].sort((a: RunWithProject, b: RunWithProject) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()))
      else setError(data.error || '取得失敗')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  const cancelRun = async (runId: string) => {
    try {
      await fetch(`/api/projects/runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'error' }),
      })
      await load()
    } catch {
      // silently ignore
    }
  }

  const deleteRunEntry = async (run: RunWithProject) => {
    const label = `「${run.label}」`
    if (!confirm(`${label} を削除しますか？\n関連する収集データも全て削除されます。`)) return
    try {
      await fetch(`/api/projects/runs/${run.id}`, { method: 'DELETE' })
      await load()
    } catch {
      // silently ignore
    }
  }

  const retryRun = async (run: RunWithProject) => {
    try {
      const newRunId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
      const st = run.searchTarget
      await fetch('/api/queue/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: newRunId,
          projectId: run.projectId,
          label: run.label,
          industry: st?.industry ?? '',
          area: st?.area ?? '',
          // Pass individual areas array when available (enables exact multi-area reproduction)
          ...(st?.areas && st.areas.length > 1 ? { areas: st.areas } : {}),
          keywords: st?.keywords ?? [],
          maxResults: st?.maxResults ?? 50,
          // Preserve radius mode parameters if the original run used them
          ...(st?.searchMode === 'radius' && {
            searchMode: 'radius',
            lat: st.lat,
            lng: st.lng,
            radiusKm: st.radiusKm,
          }),
        }),
      })
      await load()
    } catch {
      // silently ignore
    }
  }

  useEffect(() => { load() }, [])

  useEffect(() => {
    const hasRunning = runs.some((r) => r.status === 'running' || r.status === 'pending')
    if (!hasRunning) return
    const t = setTimeout(load, 5000)
    return () => clearTimeout(t)
  }, [runs])

  const filteredRuns = useMemo(() => {
    return runs.filter((r) => {
      if (statusFilter && r.status !== statusFilter) return false
      if (search) {
        const q = search.toLowerCase()
        if (!r.label.toLowerCase().includes(q) && !r.projectName.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [runs, search, statusFilter])

  const runningCount = runs.filter((r) => r.status === 'running' || r.status === 'pending').length

  return (
    <div className="p-6 space-y-4 h-full flex flex-col">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">実行履歴</h1>
          <p className="text-sm text-gray-500 mt-1">
            {loading ? '読み込み中...' : `${filteredRuns.length} / ${runs.length}件`}
            {runningCount > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-xs text-blue-600">
                <RefreshCw className="w-3 h-3 animate-spin" />{runningCount}件実行中
              </span>
            )}
          </p>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-2 py-1.5 transition-colors disabled:opacity-50 bg-white"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
          更新
        </button>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="ラベル・プロジェクト名で検索..."
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-gray-300 rounded focus:outline-none focus:border-blue-400"
          />
        </div>
        <div className="relative">
          <Filter className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400 pointer-events-none" />
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="pl-8 pr-8 py-1.5 text-sm bg-white border border-gray-300 rounded focus:outline-none focus:border-blue-400 appearance-none"
          >
            {STATUS_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="flex-1 bg-white rounded border border-gray-200 shadow-sm overflow-hidden flex flex-col min-h-0">
        <div className="overflow-auto flex-1">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10">
              <tr className="border-b border-gray-200 bg-gray-50">
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">実行</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">プロジェクト</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">ステータス</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">収集件数</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">トークン / コスト</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">開始日時</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">実行時間</th>
                <th className="text-left px-4 py-3 text-xs text-gray-500 font-medium whitespace-nowrap">結果</th>
              </tr>
            </thead>
            <tbody>
              {loading && runs.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                    <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                    読み込み中...
                  </td>
                </tr>
              )}
              {!loading && filteredRuns.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-12 text-center text-gray-400">
                    {runs.length === 0 ? '実行履歴がありません' : '条件に一致する実行がありません'}
                  </td>
                </tr>
              )}
              {filteredRuns.map((run, i) => (
                <tr
                  key={run.id}
                  className={`border-b border-gray-100 hover:bg-gray-50 transition-colors ${i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}
                >
                  {/* Run label */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {run.status === 'running'
                        ? <Play className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                        : run.status === 'success' || run.status === 'completed'
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
                        : run.status === 'error'
                        ? <XCircle className="w-3.5 h-3.5 text-red-500 flex-shrink-0" />
                        : <Clock className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
                      }
                      <div>
                        <div className="text-gray-800 font-medium text-xs leading-tight max-w-[200px] truncate" title={run.label}>
                          {run.label}
                        </div>
                        <div className="text-gray-400 text-xs mt-0.5 font-mono">
                          {run.id.slice(0, 20)}
                        </div>
                      </div>
                    </div>
                  </td>

                  {/* Project */}
                  <td className="px-4 py-3">
                    <button
                      onClick={() => router.push(`/results/${run.projectId}`)}
                      className="flex items-center gap-1.5 text-xs text-gray-600 hover:text-blue-600 transition-colors"
                    >
                      <FolderOpen className="w-3.5 h-3.5 flex-shrink-0" />
                      <span className="max-w-[140px] truncate" title={run.projectName}>
                        {run.projectName}
                      </span>
                    </button>
                  </td>

                  {/* Status */}
                  <td className="px-4 py-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <StatusBadge status={run.status} />
                        {run.status === 'pending' && run.queuePosition !== undefined && run.queuePosition > 0 && (
                          <span className="text-xs text-yellow-600 font-medium">
                            #{run.queuePosition}待ち
                          </span>
                        )}
                        {(run.status === 'running' || run.status === 'pending') && (
                          <button
                            onClick={() => cancelRun(run.id)}
                            className="text-xs px-1.5 py-0.5 rounded border border-gray-300 text-gray-500 hover:text-red-600 hover:border-red-300 transition-colors"
                          >
                            キャンセル
                          </button>
                        )}
                        {run.status === 'error' && (
                          <button
                            onClick={() => retryRun(run)}
                            className="text-xs px-1.5 py-0.5 rounded border border-gray-300 text-gray-500 hover:text-blue-600 hover:border-blue-300 transition-colors"
                          >
                            再実行
                          </button>
                        )}
                      </div>
                      {run.status === 'error' && run.error && (
                        <div className="text-xs text-red-500 max-w-[200px] truncate" title={run.error}>
                          {run.error}
                        </div>
                      )}
                    </div>
                  </td>

                  {/* Items written */}
                  <td className="px-4 py-3">
                    {run.itemsWritten !== undefined ? (
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1.5 text-sm font-medium text-gray-900">
                          <Database className="w-3.5 h-3.5 text-blue-500 flex-shrink-0" />
                          {run.itemsWritten.toLocaleString()}件
                        </div>
                        {run.rawSearchCount !== undefined && run.rawSearchCount > 0 && (
                          <div className="flex items-center gap-1 text-xs text-gray-400">
                            <ListOrdered className="w-3 h-3 flex-shrink-0" />
                            {run.rawSearchCount.toLocaleString()}件中&nbsp;
                            <span className={
                              (run.itemsWritten / run.rawSearchCount) >= 0.1 ? 'text-green-600' :
                              (run.itemsWritten / run.rawSearchCount) >= 0.05 ? 'text-yellow-600' : 'text-red-500'
                            }>
                              {((run.itemsWritten / run.rawSearchCount) * 100).toFixed(1)}%
                            </span>
                          </div>
                        )}
                        {(() => {
                          const r = run as RunWithProject & { results?: { formFoundCount?: number; afterDedup?: number } }
                          if (r.results?.formFoundCount !== undefined && r.results?.afterDedup !== undefined && r.results.afterDedup > 0) {
                            const rate = (r.results.formFoundCount / r.results.afterDedup) * 100
                            return (
                              <div className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs border ${
                                rate >= 50 ? 'bg-green-50 text-green-700 border-green-300' :
                                rate >= 20 ? 'bg-yellow-50 text-yellow-700 border-yellow-300' :
                                'bg-red-50 text-red-600 border-red-300'
                              }`}>
                                フォーム発見率: {rate.toFixed(1)}%
                              </div>
                            )
                          }
                          return null
                        })()}
                      </div>
                    ) : (
                      <span className="text-gray-400 text-xs">
                        {run.status === 'running' ? '収集中...' : '-'}
                      </span>
                    )}
                  </td>

                  {/* Token / Cost */}
                  <td className="px-4 py-3">
                    {run.tokensInput !== undefined ? (
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1 text-xs text-gray-600">
                          <Zap className="w-3 h-3 text-yellow-500 flex-shrink-0" />
                          {((run.tokensInput + (run.tokensOutput ?? 0)) / 1000).toFixed(1)}k tok
                        </div>
                        {run.estimatedCostUsd !== undefined && (
                          <div className="flex items-center gap-1 text-xs text-gray-400">
                            <DollarSign className="w-3 h-3 text-green-500 flex-shrink-0" />
                            ${run.estimatedCostUsd.toFixed(2)}
                          </div>
                        )}
                      </div>
                    ) : run.estimatedCostUsd !== undefined ? (
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-1 text-xs text-gray-400">
                          <DollarSign className="w-3 h-3 text-green-500 flex-shrink-0" />
                          ${run.estimatedCostUsd.toFixed(2)}
                          <span className="text-gray-300 text-xs">Places</span>
                        </div>
                      </div>
                    ) : (
                      <span className="text-gray-300 text-xs">-</span>
                    )}
                  </td>

                  {/* Start time */}
                  <td className="px-4 py-3">
                    <div className="text-gray-700 text-xs">
                      {new Date(run.createdAt).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}
                    </div>
                    <div className="text-gray-400 text-xs mt-0.5">{timeAgo(run.createdAt)}</div>
                  </td>

                  {/* Duration */}
                  <td className="px-4 py-3 text-gray-600 text-xs whitespace-nowrap">
                    {formatDuration(run.createdAt, run.completedAt)}
                  </td>

                  {/* Link to results + delete */}
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {(run.status === 'success' || run.status === 'completed') && run.itemsWritten && run.itemsWritten > 0 ? (
                        <button
                          onClick={() => router.push(`/results/${run.projectId}`)}
                          className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 transition-colors"
                        >
                          結果を見る
                          <ChevronRight className="w-3 h-3" />
                        </button>
                      ) : (
                        <span className="text-gray-300 text-xs">-</span>
                      )}
                      {(run.status === 'success' || run.status === 'completed' || run.status === 'error') && (
                        <button
                          onClick={() => deleteRunEntry(run)}
                          className="p-1 text-gray-300 hover:text-red-500 transition-colors"
                          title="このランを削除"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
