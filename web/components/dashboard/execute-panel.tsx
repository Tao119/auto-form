'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import dynamic from 'next/dynamic'
import { Play, Loader2, CheckCircle2, XCircle, ChevronDown, Plus, FolderOpen, Database, X, Map, List, Hash } from 'lucide-react'
import type { Preset, Project, SearchMode } from '@/lib/types'
import { ProjectCreateModal } from '@/components/modals/project-create-modal'
import type { MapPickerValue } from './map-picker'

const MapPicker = dynamic(() => import('./map-picker'), { ssr: false })

const INDUSTRIES = ['美容室', 'ヘアサロン', 'エステサロン', '美容クリニック', '歯科医院', '整骨院', '中古車販売', 'その他']

const AREAS_BY_REGION: Record<string, string[]> = {
  '北海道・東北': ['北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県'],
  '関東':         ['東京都', '神奈川県', '埼玉県', '千葉県', '茨城県', '栃木県', '群馬県'],
  '中部':         ['愛知県', '静岡県', '新潟県', '長野県', '山梨県', '岐阜県', '富山県', '石川県', '福井県'],
  '近畿':         ['大阪府', '兵庫県', '京都府', '奈良県', '和歌山県', '滋賀県', '三重県'],
  '中国・四国':   ['広島県', '岡山県', '鳥取県', '島根県', '山口県', '香川県', '愛媛県', '高知県', '徳島県'],
  '九州・沖縄':   ['福岡県', '熊本県', '鹿児島県', '長崎県', '大分県', '宮崎県', '佐賀県', '沖縄県'],
}

const ALL_AREAS = Object.values(AREAS_BY_REGION).flat()

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

interface BatchProgress {
  total: number
  done: number
  success: number
  error: number
}

const MAX_RESULTS_OPTIONS = [
  { label: '50件', value: 50 },
  { label: '100件', value: 100 },
  { label: '200件', value: 200 },
  { label: '500件', value: 500 },
  { label: '無制限', value: 0 },
]

const SEARCH_MODE_LABELS: Record<SearchMode, string> = {
  prefecture: '都道府県',
  radius: '地図指定',
}

function generateRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

export default function ExecutePanel() {
  const [searchMode, setSearchMode] = useState<SearchMode>('prefecture')
  const [industry, setIndustry] = useState('美容室')
  const [customIndustry, setCustomIndustry] = useState('')
  const [selectedAreas, setSelectedAreas] = useState<string[]>(['東京都'])
  const [areaDropdownOpen, setAreaDropdownOpen] = useState(false)
  const areaDropdownRef = useRef<HTMLDivElement>(null)
  const [mapValue, setMapValue] = useState<MapPickerValue | null>(null)

  const [status, setStatus] = useState<Status>('idle')
  const [log, setLog] = useState('')
  const [presets, setPresets] = useState<Preset[]>([])
  const [showPresets, setShowPresets] = useState(false)
  const [itemsWritten, setItemsWritten] = useState(0)
  const [liveCount, setLiveCount] = useState(0)
  const [queuePosition, setQueuePosition] = useState(0)
  const [batchProgress, setBatchProgress] = useState<BatchProgress | null>(null)
  const [maxResults, setMaxResults] = useState(50)

  const [projects, setProjects] = useState<Project[]>([])
  const [selectedProjectId, setSelectedProjectId] = useState<string>('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [queueStats, setQueueStats] = useState<{ active: number; waiting: number; maxConcurrent: number } | null>(null)

  const actualIndustry = industry === 'その他' ? customIndustry : industry
  const isRunning = status === 'running' || status === 'queued'
  const canExecute = !isRunning && !!actualIndustry && !!selectedProjectId &&
    (searchMode !== 'prefecture' || selectedAreas.length > 0) &&
    (searchMode !== 'radius' || !!mapValue)

  // Close area dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (areaDropdownRef.current && !areaDropdownRef.current.contains(e.target as Node)) {
        setAreaDropdownOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter to execute
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canExecute) {
        e.preventDefault()
        handleExecute()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [canExecute]) // eslint-disable-line react-hooks/exhaustive-deps

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

    const refreshQueue = () => {
      fetch('/api/queue').then(r => r.json()).then(d => {
        if (d.success) setQueueStats({
          active: d.data.active,
          waiting: d.data.waiting,
          maxConcurrent: d.data.maxConcurrent,
        })
      }).catch(() => {})
    }
    refreshQueue()
    const t = setInterval(refreshQueue, 8000)
    return () => clearInterval(t)
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleArea = (a: string) => {
    setSelectedAreas((prev) =>
      prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a]
    )
  }

  const selectRegion = (region: string) => {
    const areas = AREAS_BY_REGION[region]
    const allSelected = areas.every((a) => selectedAreas.includes(a))
    if (allSelected) {
      setSelectedAreas((prev) => prev.filter((a) => !areas.includes(a)))
    } else {
      setSelectedAreas((prev) => Array.from(new Set([...prev, ...areas])))
    }
  }

  // Poll a single run and return its final status; updates live counters along the way
  const pollSingleRun = useCallback((runId: string): Promise<'success' | 'error'> => {
    return new Promise((resolve) => {
      const interval = setInterval(async () => {
        try {
          const res = await fetch(`/api/projects/runs/${runId}`)
          const data = await res.json()
          const run = data.data
          if (!run) return

          // Update live counter whenever itemsWritten changes
          if (run.itemsWritten !== undefined && run.itemsWritten > 0) {
            setLiveCount(run.itemsWritten)
          }
          // Update queue position
          if (run.queuePosition !== undefined) {
            setQueuePosition(run.queuePosition)
            if (run.queuePosition > 0) setStatus('queued')
          } else {
            setQueuePosition(0)
          }

          if (run.status === 'success' || run.status === 'completed') {
            clearInterval(interval)
            setItemsWritten(run.itemsWritten ?? 0)
            resolve('success')
          } else if (run.status === 'error') {
            clearInterval(interval)
            resolve('error')
          }
        } catch {
          // continue polling
        }
      }, 3000)
    })
  }, [])

  const handleExecute = async () => {
    if (!actualIndustry || !selectedProjectId) return
    if (searchMode === 'prefecture' && selectedAreas.length === 0) return
    if (searchMode === 'radius' && !mapValue) return

    setStatus('running')
    setItemsWritten(0)
    setLiveCount(0)
    setBatchProgress(null)

    const keywords = KEYWORDS_MAP[actualIndustry] || [actualIndustry]
    const runIds: string[] = []
    const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).slice(0, 16)

    if (searchMode === 'radius' && mapValue) {
      // Single job for map-based radius search
      setLog('地図指定エリアをキューに追加中...')
      const runId = generateRunId()
      runIds.push(runId)
      const areaLabel = mapValue.label || `${mapValue.lat.toFixed(3)},${mapValue.lng.toFixed(3)}`
      const runLabel = `${actualIndustry} / ${areaLabel} 半径${mapValue.radiusKm}km ${timestamp}`

      try {
        const res = await fetch('/api/queue/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId,
            projectId: selectedProjectId,
            label: runLabel,
            industry: actualIndustry,
            area: areaLabel,
            keywords,
            maxResults,
            searchMode: 'radius',
            lat: mapValue.lat,
            lng: mapValue.lng,
            radiusKm: mapValue.radiusKm,
          }),
        })
        const data = await res.json()
        if (!data.success) {
          setLog(`キュー追加失敗: ${data.error}`)
        }
      } catch (e) {
        setLog(`エラー: ${String(e)}`)
      }
    } else {
      // Prefecture mode: single job covering all selected areas
      const runId = generateRunId()
      runIds.push(runId)
      const areaLabel = selectedAreas.length === 1
        ? selectedAreas[0]
        : `${selectedAreas.slice(0, 2).join('・')}${selectedAreas.length > 2 ? ` 他${selectedAreas.length - 2}件` : ''}`
      const runLabel = `${actualIndustry} / ${areaLabel} ${timestamp}`

      setLog(`${selectedAreas.length > 1 ? `${selectedAreas.length} エリア（1セッション）` : selectedAreas[0]} をキューに追加中...`)

      try {
        const res = await fetch('/api/queue/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            runId,
            projectId: selectedProjectId,
            label: runLabel,
            industry: actualIndustry,
            area: areaLabel,
            areas: selectedAreas,
            keywords,
            maxResults,
          }),
        })
        const data = await res.json()
        if (!data.success) {
          setLog(`キュー追加失敗: ${data.error}`)
        }
      } catch (e) {
        setLog(`エラー: ${String(e)}`)
      }
    }

    const progress: BatchProgress = { total: runIds.length, done: 0, success: 0, error: 0 }
    setBatchProgress({ ...progress })
    setStatus('running')
    setLog(`${runIds.length} エリアを実行開始しました`)

    // Poll all runs in parallel
    const polls = runIds.map((runId) =>
      pollSingleRun(runId).then((result) => {
        progress.done++
        if (result === 'success') progress.success++
        else progress.error++
        setBatchProgress({ ...progress })
        if (progress.done === progress.total) {
          const allOk = progress.error === 0
          setStatus(allOk ? 'success' : progress.success > 0 ? 'success' : 'error')
          setLog(
            allOk
              ? `完了: ${progress.success} エリア全て成功`
              : `完了: ${progress.success} 成功 / ${progress.error} 失敗`
          )
        }
      })
    )

    Promise.all(polls).catch(() => {})
  }

  const loadPreset = (preset: Preset) => {
    const t = preset.searchTarget
    if (INDUSTRIES.includes(t.industry)) {
      setIndustry(t.industry)
    } else {
      setIndustry('その他')
      setCustomIndustry(t.industry)
    }
    setSelectedAreas([t.area])
    setShowPresets(false)
  }

  const saveCurrentAsPreset = async () => {
    const name = prompt('プリセット名を入力してください:')
    if (!name) return
    const keywords = KEYWORDS_MAP[actualIndustry] || [actualIndustry]
    const area = selectedAreas.length === 1 ? selectedAreas[0] : selectedAreas.join(',')
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
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold text-gray-800">リスト収集を実行</h2>
          {queueStats !== null && (
            <span className={`text-xs px-2 py-0.5 rounded border ${
              queueStats.active > 0
                ? 'bg-blue-50 text-blue-600 border-blue-200'
                : 'bg-gray-50 text-gray-400 border-gray-200'
            }`}>
              {queueStats.active}/{queueStats.maxConcurrent} 実行中
              {queueStats.waiting > 0 && ` · ${queueStats.waiting} 待機`}
            </span>
          )}
        </div>
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
            disabled={isRunning}
          >
            {projects.length === 0 && <option value="">プロジェクトを作成してください</option>}
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-2 py-1.5 transition-colors bg-white"
            disabled={isRunning}
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

      {/* Search mode toggle */}
      <div className="flex items-center gap-1 bg-gray-100 rounded p-0.5 w-fit">
        {(['prefecture', 'radius'] as SearchMode[]).map((mode) => (
          <button
            key={mode}
            onClick={() => { if (!isRunning) setSearchMode(mode) }}
            disabled={isRunning}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-medium transition-colors ${
              searchMode === mode
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {mode === 'prefecture' ? <List className="w-3.5 h-3.5" /> : <Map className="w-3.5 h-3.5" />}
            {SEARCH_MODE_LABELS[mode]}
          </button>
        ))}
      </div>

      {/* Search params */}
      <div className={`grid gap-3 ${searchMode === 'prefecture' ? 'grid-cols-1 sm:grid-cols-2' : 'grid-cols-1'}`}>
        {/* Industry */}
        <div>
          <label className="block text-xs text-gray-500 mb-1">業種</label>
          <select
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
            disabled={isRunning}
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

        {/* Map mode */}
        {searchMode === 'radius' && (
          <div>
            <label className="block text-xs text-gray-500 mb-1">調査エリア（地図で指定）</label>
            <MapPicker
              value={mapValue}
              onChange={setMapValue}
              disabled={isRunning}
            />
          </div>
        )}

        {/* Prefecture multi-select */}
        {searchMode === 'prefecture' && (
        <div ref={areaDropdownRef}>
          <div className="flex items-center justify-between mb-1">
            <label className="text-xs text-gray-500">エリア</label>
            <span className="text-xs text-gray-400">{selectedAreas.length} 選択中</span>
          </div>

          {/* Trigger button */}
          <button
            type="button"
            onClick={() => setAreaDropdownOpen((v) => !v)}
            disabled={isRunning}
            className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none flex items-center justify-between disabled:opacity-50"
          >
            <span className="truncate text-left">
              {selectedAreas.length === 0
                ? 'エリアを選択...'
                : selectedAreas.length === ALL_AREAS.length
                ? '全都道府県'
                : selectedAreas.length <= 3
                ? selectedAreas.join('・')
                : `${selectedAreas.slice(0, 2).join('・')} 他${selectedAreas.length - 2}件`}
            </span>
            <ChevronDown className={`w-4 h-4 text-gray-400 flex-shrink-0 transition-transform ${areaDropdownOpen ? 'rotate-180' : ''}`} />
          </button>

          {/* Dropdown panel */}
          {areaDropdownOpen && (
            <div className="absolute z-20 mt-1 bg-white border border-gray-200 rounded shadow-lg w-80 max-h-96 overflow-y-auto">
              {/* Quick actions */}
              <div className="flex gap-2 px-3 py-2 border-b border-gray-100 bg-gray-50 sticky top-0">
                <button
                  onClick={() => setSelectedAreas([...ALL_AREAS])}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  全選択
                </button>
                <span className="text-gray-300">|</span>
                <button
                  onClick={() => setSelectedAreas([])}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  全解除
                </button>
                <span className="text-gray-300">|</span>
                <button
                  onClick={() => setSelectedAreas(['東京都', '大阪府', '神奈川県', '愛知県', '福岡県'])}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  主要5都市
                </button>
              </div>

              {/* Regions */}
              {Object.entries(AREAS_BY_REGION).map(([region, areas]) => {
                const allSelected = areas.every((a) => selectedAreas.includes(a))
                const someSelected = areas.some((a) => selectedAreas.includes(a))
                return (
                  <div key={region} className="border-b border-gray-50 last:border-0">
                    <button
                      onClick={() => selectRegion(region)}
                      className="w-full flex items-center gap-2 px-3 py-1.5 bg-gray-50 hover:bg-gray-100 text-left"
                    >
                      <span className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center text-white text-[9px] ${
                        allSelected ? 'bg-blue-500 border-blue-500' : someSelected ? 'bg-blue-200 border-blue-300' : 'border-gray-300'
                      }`}>
                        {allSelected ? '✓' : someSelected ? '−' : ''}
                      </span>
                      <span className="text-xs font-medium text-gray-600">{region}</span>
                      <span className="text-xs text-gray-400 ml-auto">
                        {areas.filter(a => selectedAreas.includes(a)).length}/{areas.length}
                      </span>
                    </button>
                    <div className="grid grid-cols-3 gap-0.5 px-2 py-1">
                      {areas.map((a) => (
                        <button
                          key={a}
                          onClick={() => toggleArea(a)}
                          className={`flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors ${
                            selectedAreas.includes(a)
                              ? 'bg-blue-100 text-blue-700 font-medium'
                              : 'text-gray-600 hover:bg-gray-100'
                          }`}
                        >
                          <span className={`w-2.5 h-2.5 rounded-sm border flex-shrink-0 ${
                            selectedAreas.includes(a) ? 'bg-blue-500 border-blue-500' : 'border-gray-300'
                          }`} />
                          {a.replace(/[都道府県]$/, '')}
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Selected area pills */}
          {selectedAreas.length > 0 && !areaDropdownOpen && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {selectedAreas.slice(0, 8).map((a) => (
                <span
                  key={a}
                  className="inline-flex items-center gap-0.5 bg-blue-50 text-blue-700 text-xs px-1.5 py-0.5 rounded"
                >
                  {a.replace(/[都道府県]$/, '')}
                  {!isRunning && (
                    <button onClick={() => toggleArea(a)} className="hover:text-blue-900 ml-0.5">
                      <X className="w-2.5 h-2.5" />
                    </button>
                  )}
                </span>
              ))}
              {selectedAreas.length > 8 && (
                <span className="text-xs text-gray-400 py-0.5">+{selectedAreas.length - 8}</span>
              )}
            </div>
          )}
        </div>
        )}
      </div>

      {/* MaxResults + Execute */}
      <div className="space-y-2">
        <div className="flex items-center gap-3">
          {/* Max results selector */}
          <div className="flex items-center gap-1.5">
            <Hash className="w-3.5 h-3.5 text-gray-400" />
            <select
              value={maxResults}
              onChange={(e) => setMaxResults(Number(e.target.value))}
              disabled={isRunning}
              className="bg-white border border-gray-300 rounded px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none disabled:opacity-50"
            >
              {MAX_RESULTS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </div>

          <button
            onClick={handleExecute}
            disabled={!canExecute}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed text-white font-medium px-5 py-2 rounded transition-colors text-sm"
            title="Ctrl+Enter / ⌘+Enter"
          >
            {isRunning ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {status === 'queued' ? '待機中...' : '実行中...'}</>
            ) : searchMode === 'radius' ? (
              <><Play className="w-4 h-4" /> 実行開始</>
            ) : (
              <><Play className="w-4 h-4" />
                {selectedAreas.length > 1
                  ? `${selectedAreas.length} エリア 実行開始`
                  : '実行開始'}
              </>
            )}
          </button>

          {status !== 'idle' && !batchProgress && (
            <div className="flex items-center gap-2 text-sm">
              {isRunning && <span className="text-blue-500 animate-pulse">●</span>}
              {status === 'success' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
              {status === 'error' && <XCircle className="w-4 h-4 text-red-500" />}
              <span className={
                status === 'success' ? 'text-green-700' :
                status === 'error' ? 'text-red-600' : 'text-blue-700'
              }>{log}</span>
            </div>
          )}
        </div>

        {/* Queue position indicator */}
        {status === 'queued' && queuePosition > 0 && (
          <div className="flex items-center gap-2 bg-yellow-50 border border-yellow-200 rounded px-3 py-2">
            <Loader2 className="w-3.5 h-3.5 text-yellow-600 animate-spin flex-shrink-0" />
            <span className="text-yellow-700 text-xs font-medium">
              キュー待機中 — {queuePosition}番目
            </span>
          </div>
        )}

        {/* Batch progress */}
        {batchProgress && (
          <div className="bg-blue-50 border border-blue-200 rounded px-3 py-2.5 space-y-1.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-blue-700 font-medium">
                {batchProgress.done < batchProgress.total ? (
                  <><Loader2 className="w-3 h-3 animate-spin inline mr-1" />実行中...</>
                ) : (
                  <><CheckCircle2 className="w-3 h-3 inline mr-1 text-green-600" />完了</>
                )}
              </span>
              <span className="text-blue-600">
                {batchProgress.done} / {batchProgress.total} エリア
                {batchProgress.error > 0 && (
                  <span className="text-red-500 ml-1">（{batchProgress.error} 失敗）</span>
                )}
              </span>
            </div>
            <div className="w-full bg-blue-100 rounded-full h-1.5">
              <div
                className={`h-1.5 rounded-full transition-all ${batchProgress.error > 0 ? 'bg-yellow-500' : 'bg-blue-500'}`}
                style={{ width: `${(batchProgress.done / batchProgress.total) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Live counter */}
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
    </div>
    </>
  )
}
