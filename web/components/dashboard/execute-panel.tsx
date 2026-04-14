'use client'

import { useState, useEffect, useCallback } from 'react'
import { Play, Loader2, CheckCircle2, XCircle, ChevronDown, Plus, FolderOpen, Database } from 'lucide-react'
import type { Preset, Project } from '@/lib/types'
import { ProjectCreateModal } from '@/components/modals/project-create-modal'

const INDUSTRIES = ['美容室', 'ヘアサロン', 'エステサロン', '美容クリニック', '歯科医院', '整骨院', '中古車販売', 'その他']
const AREAS = ['東京都', '大阪府', '神奈川県', '愛知県', '福岡県', '埼玉県', '千葉県', '北海道', '宮城県', '広島県', '全国']
const KEYWORDS_MAP: Record<string, string[]> = {
  '美容室': ['美容室', 'ヘアサロン', '美容院'],
  'ヘアサロン': ['ヘアサロン', '美容室', 'サロン'],
  'エステサロン': ['エステサロン', 'エステ', 'フェイシャル'],
  '美容クリニック': ['美容クリニック', '美容外科', '美容皮膚科'],
  '歯科医院': ['歯科医院', '歯医者', 'デンタルクリニック'],
  '整骨院': ['整骨院', '接骨院', '整体'],
  '中古車販売': ['中古車販売', '中古車', 'カーディーラー'],
}

type Status = 'idle' | 'queued' | 'running' | 'success' | 'error'

function generateRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

export default function ExecutePanel() {
  const [industry, setIndustry] = useState('美容室')
  const [customIndustry, setCustomIndustry] = useState('')
  const [area, setArea] = useState('東京都')
  const [status, setStatus] = useState<Status>('idle')
  const [execId, setExecId] = useState<string | null>(null)
  const [log, setLog] = useState('')
  const [presets, setPresets] = useState<Preset[]>([])
  const [showPresets, setShowPresets] = useState(false)
  const [itemsWritten, setItemsWritten] = useState(0)
  const [liveCount, setLiveCount] = useState(0)
  const [queuePosition, setQueuePosition] = useState(0)
  const [currentRunId, setCurrentRunId] = useState<string | null>(null)

  // Project state
  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [showCreateModal, setShowCreateModal] = useState(false)

  const actualIndustry = industry === 'その他' ? customIndustry : industry

  useEffect(() => {
    fetch('/api/config/presets').then((r) => r.json()).then((d) => {
      if (d.success) setPresets(d.data)
    }).catch(() => {})

    fetch('/api/projects').then((r) => r.json()).then((d) => {
      if (d.success) {
        setProjects(d.data)
        if (d.data.length > 0 && !selectedProjectId) {
          setSelectedProjectId(d.data[0].id)
        }
      }
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const pollRunStatus = useCallback((runId: string) => {
    const interval = setInterval(async () => {
      try {
        await fetch('/api/projects/runs/sync', { method: 'POST' }).catch(() => {})

        const res = await fetch(`/api/projects/runs/${runId}`)
        const data = await res.json()
        const run = data.data
        if (!run) return

        if (run.status === 'queued' || run.status === 'pending') {
          setStatus('queued')
          setLog(`キュー待機中 (${run.queuePosition ?? '?'}番目)`)
          return
        }

        if (run.status === 'running') {
          const n = run.itemsWritten ?? 0
          setLiveCount(n)
          setLog(n > 0 ? `実行中... ${n.toLocaleString()}件収集済み` : '実行中...')
          return
        }

        clearInterval(interval)
        setStatus(run.status)
        setLiveCount(0)
        setItemsWritten(run.itemsWritten ?? 0)
        if (run.status === 'success') {
          const costStr = run.estimatedCostUsd
            ? ` (${(run.estimatedCostUsd * 150).toFixed(1)}円)`
            : ''
          const tokenStr = run.tokensInput
            ? ` • ${((run.tokensInput + (run.tokensOutput ?? 0)) / 1000).toFixed(1)}kトークン${costStr}`
            : ''
          setLog(`完了: ${run.itemsWritten ?? 0}件を収集${tokenStr}`)
        } else {
          setLog('エラー: 実行に失敗しました')
        }
      } catch {
        // ignore
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [])

  const handleExecute = async () => {
    if (!actualIndustry || !selectedProjectId) return
    setStatus('running')
    setLog('キューに追加中...')
    setExecId(null)
    setItemsWritten(0)
    setLiveCount(0)
    setQueuePosition(0)

    const runId = generateRunId()
    setCurrentRunId(runId)
    const keywords = KEYWORDS_MAP[actualIndustry] || [actualIndustry]
    const areaValue = area === '全国' ? '全国' : area
    const runLabel = `${actualIndustry} / ${area} ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).slice(0, 16)}`

    try {
      const res = await fetch('/api/queue/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId,
          projectId: selectedProjectId,
          label: runLabel,
          industry: actualIndustry,
          area: areaValue,
          keywords,
        }),
      })
      const data = await res.json()

      if (!data.success) {
        setStatus('error')
        setLog(`起動失敗: ${data.error}`)
        return
      }

      if (data.queued) {
        setStatus('queued')
        setQueuePosition(data.queuePosition ?? 1)
        setLog(`キュー待機中 (${data.queuePosition}番目)`)
      } else {
        setLog(`実行開始 (ID: ${data.executionId || 'webhook'})`)
        if (data.executionId) setExecId(data.executionId)
      }

      pollRunStatus(runId)
    } catch (e) {
      setStatus('error')
      setLog(`エラー: ${String(e)}`)
    }
  }

  const loadPreset = (preset: Preset) => {
    const t = preset.searchTarget
    if (INDUSTRIES.includes(t.industry)) {
      setIndustry(t.industry)
    } else {
      setIndustry('その他')
      setCustomIndustry(t.industry)
    }
    setArea(t.area)
    setShowPresets(false)
  }

  const saveCurrentAsPreset = async () => {
    const name = prompt('プリセット名を入力してください:')
    if (!name) return
    const keywords = KEYWORDS_MAP[actualIndustry] || [actualIndustry]
    await fetch('/api/config/presets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, searchTarget: { industry: actualIndustry, area, keywords } }),
    })
    const r = await fetch('/api/config/presets')
    const d = await r.json()
    if (d.success) setPresets(d.data)
  }

  const selectedProject = projects.find((p) => p.id === selectedProjectId)

  return (
    <>
    <ProjectCreateModal
      open={showCreateModal}
      onClose={() => setShowCreateModal(false)}
      onCreate={(project) => {
        setProjects((prev) => [project, ...prev])
        setSelectedProjectId(project.id)
      }}
    />
    <div className="bg-white rounded border border-gray-200 shadow-sm p-5 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-800">リスト収集を実行</h2>
        <div className="relative">
          <button
            onClick={() => setShowPresets(!showPresets)}
            className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 border border-gray-300 rounded px-2 py-1"
          >
            プリセット <ChevronDown className="w-3 h-3" />
          </button>
          {showPresets && (
            <div className="absolute right-0 top-8 bg-white border border-gray-200 rounded shadow-md z-10 min-w-48">
              {presets.length === 0 ? (
                <div className="px-3 py-2 text-xs text-gray-400">プリセットなし</div>
              ) : (
                presets.map((p) => (
                  <button key={p.id} onClick={() => loadPreset(p)}
                    className="w-full text-left px-3 py-2 text-sm text-gray-700 hover:bg-gray-50">
                    {p.name}
                  </button>
                ))
              )}
              <div className="border-t border-gray-100 px-3 py-2">
                <button onClick={saveCurrentAsPreset} className="text-xs text-blue-600 hover:text-blue-800">
                  現在の設定を保存
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Project selector */}
      <div className="bg-gray-50 rounded border border-gray-200 p-3">
        <div className="flex items-center gap-2 mb-2">
          <FolderOpen className="w-3.5 h-3.5 text-gray-400" />
          <span className="text-xs text-gray-500 font-medium">プロジェクト</span>
        </div>
        <div className="flex gap-2">
          <select
            value={selectedProjectId}
            onChange={(e) => setSelectedProjectId(e.target.value)}
            className="flex-1 bg-white border border-gray-300 rounded px-2 py-1.5 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
            disabled={status === 'running'}
          >
            {projects.length === 0 && <option value="">プロジェクトを作成してください</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-2 py-1.5 transition-colors bg-white"
            disabled={status === 'running'}
          >
            <Plus className="w-3 h-3" /> 新規
          </button>
        </div>
        {selectedProject && (
          <div className="mt-1.5 text-xs text-gray-400">
            {selectedProject.runIds.length}回の実行{selectedProject.description ? ` — ${selectedProject.description}` : ''}
          </div>
        )}
        {!selectedProjectId && (
          <p className="mt-1.5 text-xs text-yellow-600">実行前にプロジェクトを作成または選択してください</p>
        )}
      </div>

      {/* Search params */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-gray-500 mb-1">業種</label>
          <select
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
            disabled={status === 'running'}
          >
            {INDUSTRIES.map((i) => <option key={i}>{i}</option>)}
          </select>
          {industry === 'その他' && (
            <input
              type="text"
              value={customIndustry}
              onChange={(e) => setCustomIndustry(e.target.value)}
              placeholder="業種を入力..."
              className="mt-1 w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
            />
          )}
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">エリア</label>
          <select
            value={area}
            onChange={(e) => setArea(e.target.value)}
            className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
            disabled={status === 'running'}
          >
            {AREAS.map((a) => <option key={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {/* Execute */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          <button
            onClick={handleExecute}
            disabled={status === 'running' || status === 'queued' || !actualIndustry || !selectedProjectId}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded transition-colors text-sm"
          >
            {status === 'running' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> 実行中...</>
            ) : status === 'queued' ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> 待機中...</>
            ) : (
              <><Play className="w-4 h-4" /> 実行開始</>
            )}
          </button>

          {status !== 'idle' && (
            <div className="flex items-center gap-2 text-sm">
              {status === 'running' && <span className="text-blue-500 animate-pulse">●</span>}
              {status === 'queued' && <span className="text-yellow-500">◐</span>}
              {status === 'success' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
              {status === 'error' && <XCircle className="w-4 h-4 text-red-500" />}
              <span className={
                status === 'success' ? 'text-green-700' :
                status === 'error' ? 'text-red-600' :
                status === 'queued' ? 'text-yellow-700' : 'text-blue-700'
              }>{log}</span>
            </div>
          )}
        </div>

        {/* Live progress counter */}
        {status === 'running' && liveCount > 0 && (
          <div className="flex items-center gap-2 bg-blue-50 border border-blue-200 rounded px-3 py-2">
            <Database className="w-3.5 h-3.5 text-blue-500 flex-shrink-0 animate-pulse" />
            <span className="text-blue-700 text-xs font-medium">
              {liveCount.toLocaleString()}件 収集済み（処理継続中）
            </span>
          </div>
        )}

        {/* Result summary */}
        {status === 'success' && itemsWritten > 0 && (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 rounded px-3 py-2">
            <Database className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
            <span className="text-green-700 text-xs font-medium">
              {itemsWritten.toLocaleString()}件 をプロジェクトに追加しました
            </span>
          </div>
        )}
      </div>

      {execId && (
        <div className="text-xs text-gray-400">
          Execution ID: {execId}
        </div>
      )}
    </div>
    </>
  )
}
