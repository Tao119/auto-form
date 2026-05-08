'use client'

import { useState, useEffect, useCallback, useRef } from 'react'
import { Play, Loader2, CheckCircle2, XCircle, ChevronDown, Plus, FolderOpen, X, ExternalLink, Square, Sparkles, MapPin, Briefcase, Hash, Database } from 'lucide-react'
import { useRouter } from 'next/navigation'
import type { Preset, Project, SearchProvider } from '@/lib/types'
import { estimateCost } from '@/lib/area-data'
import { ProjectCreateModal } from '@/components/modals/project-create-modal'

const HISTORY_KEY = 'execute_panel_history'
const MAX_HISTORY = 20

function loadHistory(): { areas: string[]; industries: string[] } {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    return raw ? JSON.parse(raw) : { areas: [], industries: [] }
  } catch { return { areas: [], industries: [] } }
}
function saveToHistory(area: string, industry: string) {
  try {
    const h = loadHistory()
    const areas = [area, ...h.areas.filter((a) => a !== area)].slice(0, MAX_HISTORY)
    const industries = [industry, ...h.industries.filter((i) => i !== industry)].slice(0, MAX_HISTORY)
    localStorage.setItem(HISTORY_KEY, JSON.stringify({ areas, industries }))
  } catch {}
}

// 実測データに基づく最適キーワード設定 (2026-04-19 検証済み)
// 追加kwの限界効率が1kwの50%を下回る場合はkw数を増やさない
// 整骨院1kw=91件/$ / 歯科2kw=48件/$ / 美容室1kw=40件/$
const KEYWORDS_MAP: Record<string, string[]> = {
  '美容室':      ['美容室'],
  'ヘアサロン':  ['ヘアサロン'],
  'エステサロン': ['エステサロン', '脱毛サロン'],
  '美容クリニック': ['美容クリニック', '医療脱毛'],
  '歯科医院':    ['歯科', '矯正歯科'],
  '整骨院':      ['整骨院'],
  '中古車販売':  ['中古車', '中古車販売'],
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
  { label: '無制限', value: 1000000 },
]


function generateRunId() {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

const EP_STORAGE_KEY = 'execute_panel_settings'

function loadPanelSettings(): {
  industry?: string
  selectedAreas?: string[]; maxResults?: number; selectedProjectId?: string
} {
  try {
    const raw = localStorage.getItem(EP_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch { return {} }
}
function savePanelSettings(s: Record<string, unknown>) {
  try { localStorage.setItem(EP_STORAGE_KEY, JSON.stringify(s)) } catch {}
}

export default function ExecutePanel() {
  const router = useRouter()

  // Load persisted settings once on mount
  const [_settingsLoaded, setSettingsLoaded] = useState(false)
  const [industry, setIndustry] = useState('美容室')
  const [areaInput, setAreaInput] = useState('東京都')
  const [areaError, setAreaError] = useState('')
  const [areaValidating, setAreaValidating] = useState(false)
  const [areaValid, setAreaValid] = useState<boolean | null>(null)
  const [areaSuggestions, setAreaSuggestions] = useState<string[]>([])
  const [showAreaSuggestions, setShowAreaSuggestions] = useState(false)
  const [industrySuggestions, setIndustrySuggestions] = useState<string[]>([])
  const [showIndustrySuggestions, setShowIndustrySuggestions] = useState(false)
  const areaInputRef = useRef<HTMLInputElement>(null)
  const industryInputRef = useRef<HTMLInputElement>(null)
  const areaSuggestRef = useRef<HTMLDivElement>(null)
  const industrySuggestRef = useRef<HTMLDivElement>(null)

  // legacy — keep for preset compatibility
  const selectedAreas = [areaInput].filter(Boolean)

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
  const [presetNameInput, setPresetNameInput] = useState('')
  const [showPresetNameInput, setShowPresetNameInput] = useState(false)
  const [savingPreset, setSavingPreset] = useState(false)
  const [currentRunIds, setCurrentRunIds] = useState<string[]>([])
  const [canceling, setCanceling] = useState(false)
  const [searchProvider, setSearchProvider] = useState<SearchProvider>('serper')
  const presetDropdownRef = useRef<HTMLDivElement>(null)

  // AI keyword generation
  const [keywords, setKeywords] = useState<string[]>([])
  const [suffixes, setSuffixes] = useState<string[]>([])
  const [keywordsLoading, setKeywordsLoading] = useState(false)
  const [kwInput, setKwInput] = useState('')

  // Track when the first item appeared (for items/min rate calculation)
  const firstItemTimeRef = useRef<number | null>(null)
  const prevLiveCountRef = useRef<number>(0)

  const actualIndustry = industry
  const isRunning = status === 'running' || status === 'queued'
  const canExecute = !isRunning && !!actualIndustry && !!selectedProjectId && !!areaInput && areaValid !== false

  // Restore persisted settings on first mount
  useEffect(() => {
    const s = loadPanelSettings()
    if (s.industry) setIndustry(s.industry)
    if (Array.isArray(s.selectedAreas) && s.selectedAreas.length > 0) setAreaInput(s.selectedAreas[0])
    if (s.maxResults !== undefined) setMaxResults(s.maxResults)
    // Pre-load history for suggestions
    const h = loadHistory()
    setAreaSuggestions(h.areas)
    setIndustrySuggestions(h.industries)
    setSettingsLoaded(true)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist settings whenever they change (after initial load)
  useEffect(() => {
    if (!_settingsLoaded) return
    savePanelSettings({ industry, selectedAreas: [areaInput], maxResults, selectedProjectId })
  }, [_settingsLoaded, industry, areaInput, maxResults, selectedProjectId])

  // Validate area input (debounced 800ms)
  useEffect(() => {
    if (!areaInput.trim()) { setAreaValid(null); setAreaError(''); return }
    setAreaValid(null)
    setAreaError('')
    setAreaValidating(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/search/validate-area', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ area: areaInput.trim() }),
        })
        const data = await res.json()
        setAreaValid(data.valid !== false)
        if (data.valid === false) setAreaError(`「${areaInput}」は地名として認識できませんでした`)
        else setAreaError('')
      } catch {
        setAreaValid(true) // network error → don't block
      } finally {
        setAreaValidating(false)
      }
    }, 800)
    return () => { clearTimeout(t); setAreaValidating(false) }
  }, [areaInput])

  // Close suggestion dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (areaSuggestRef.current && !areaSuggestRef.current.contains(e.target as Node)) setShowAreaSuggestions(false)
      if (industrySuggestRef.current && !industrySuggestRef.current.contains(e.target as Node)) setShowIndustrySuggestions(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Fetch AI keyword suggestions whenever the industry or area changes (debounced 600ms)
  useEffect(() => {
    if (!actualIndustry) return
    setKeywords([actualIndustry])
    setSuffixes([])
    setKeywordsLoading(true)
    const t = setTimeout(async () => {
      try {
        const res = await fetch('/api/ai/keywords', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ industry: actualIndustry, area: areaInput.trim() || undefined }),
        })
        const data = await res.json()
        if (data.success) {
          if (Array.isArray(data.keywords) && data.keywords.length > 0) {
            setKeywords(data.keywords)
          }
          if (Array.isArray(data.suffixes)) {
            setSuffixes(data.suffixes)
          }
        }
      } catch {
        // keep fallback on error
      } finally {
        setKeywordsLoading(false)
      }
    }, 600)
    return () => { clearTimeout(t); setKeywordsLoading(false) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actualIndustry, areaInput])

  // Close preset dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (presetDropdownRef.current && !presetDropdownRef.current.contains(e.target as Node)) {
        setShowPresets(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  // Keep a ref to the latest handleExecute so the keyboard handler never captures
  // stale state (industry / area changes don't toggle canExecute, but they DO
  // change which parameters would be submitted).
  const handleExecuteRef = useRef<() => Promise<void>>(() => Promise.resolve())

  // Keyboard shortcut: Ctrl+Enter / Cmd+Enter to execute
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canExecute) {
        e.preventDefault()
        handleExecuteRef.current()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [canExecute])

  useEffect(() => {
    fetch('/api/config/presets').then((r) => r.json()).then((d) => {
      if (d.success) setPresets(d.data)
    }).catch(() => {})

    fetch('/api/projects').then((r) => r.json()).then((d) => {
      if (d.success) {
        setProjects(d.data)
        if (d.data.length > 0) {
          // Restore persisted project selection if it still exists; else default to first project
          const saved = loadPanelSettings()
          const restoredId = saved.selectedProjectId && d.data.some((p: Project) => p.id === saved.selectedProjectId)
            ? saved.selectedProjectId
            : d.data[0].id
          setSelectedProjectId((prev) => prev || restoredId)
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
            if (prevLiveCountRef.current === 0 && run.itemsWritten > 0) {
              firstItemTimeRef.current = Date.now()
            }
            prevLiveCountRef.current = run.itemsWritten
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
    if (!actualIndustry || !selectedProjectId || !areaInput) return
    saveToHistory(areaInput.trim(), actualIndustry)
    const h = loadHistory()
    setAreaSuggestions(h.areas)
    setIndustrySuggestions(h.industries)

    setStatus('running')
    setItemsWritten(0)
    setLiveCount(0)
    setBatchProgress(null)
    setCurrentRunIds([])
    firstItemTimeRef.current = null
    prevLiveCountRef.current = 0

    const activeKeywords = keywords.length > 0 ? keywords : (KEYWORDS_MAP[actualIndustry] ?? [actualIndustry])
    const effectiveAreas = selectedAreas
    const runIds: string[] = []
    const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).slice(0, 16)

    {
      // Prefecture mode: single area → single job; multiple areas → batch (parent + child runs)
      const runId = generateRunId()
      const areaLabel = selectedAreas.length === 1
        ? selectedAreas[0]
        : `${selectedAreas.slice(0, 2).join('・')}${selectedAreas.length > 2 ? ` 他${selectedAreas.length - 2}件` : ''}`
      const runLabel = `${actualIndustry} / ${areaLabel} ${timestamp}`

      const logMsg = effectiveAreas.length > 1
        ? `${effectiveAreas.length} エリア（バッチ実行）`
        : effectiveAreas[0]
      setLog(`${logMsg} をキューに追加中...`)

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
            areas: effectiveAreas,
            keywords: activeKeywords,
            suffixes: suffixes.length > 0 ? suffixes : undefined,
            maxResults,
            searchProvider,
          }),
        })
        const data = await res.json()
        if (!data.success) {
          setLog(`キュー追加失敗: ${data.error}`)
        } else if (data.batch && Array.isArray(data.childRunIds)) {
          // Batch mode: poll child runs; parent run tracks aggregated stats in history
          runIds.push(...data.childRunIds)
        } else {
          // Single-area mode
          runIds.push(runId)
        }
      } catch (e) {
        setLog(`エラー: ${String(e)}`)
        runIds.push(runId)  // fallback so polling still starts
      }
    }

    const progress: BatchProgress = { total: runIds.length, done: 0, success: 0, error: 0 }
    setBatchProgress({ ...progress })
    setCurrentRunIds([...runIds])
    setStatus('running')
    setLog(
      runIds.length > 1
        ? `${runIds.length} エリアのバッチ実行を開始しました`
        : '実行開始しました'
    )

    // Poll all runs in parallel
    const polls = runIds.map((rId) =>
      pollSingleRun(rId).then((result) => {
        progress.done++
        if (result === 'success') progress.success++
        else progress.error++
        setBatchProgress({ ...progress })
        if (progress.done === progress.total) {
          const allOk = progress.error === 0
          setStatus(allOk ? 'success' : progress.success > 0 ? 'success' : 'error')
          setCurrentRunIds([])
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
  // Sync ref on every render so the keyboard handler always calls the latest version
  useEffect(() => { handleExecuteRef.current = handleExecute })

  const handleCancel = async () => {
    if (currentRunIds.length === 0 || canceling) return
    setCanceling(true)
    try {
      await Promise.all(currentRunIds.map((runId) =>
        fetch(`/api/projects/runs/${runId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'error' }),
        }).catch(() => {})
      ))
    } finally {
      setCanceling(false)
      setCurrentRunIds([])
      setStatus('idle')
      setLog('')
      setBatchProgress(null)
      setLiveCount(0)
    }
  }

  const loadPreset = (preset: Preset) => {
    const t = preset.searchTarget
    setIndustry(t.industry)
    // area may be comma-separated — take first one
    const area = t.area.includes(',') ? t.area.split(',')[0].trim() : t.area
    setAreaInput(area)
    if (t.maxResults) setMaxResults(t.maxResults)
    setShowPresets(false)
  }

  const commitSavePreset = async () => {
    const name = presetNameInput.trim()
    if (!name) return
    setSavingPreset(true)
    try {
      const activeKeywords = keywords.length > 0 ? keywords : [actualIndustry]
      const area = areaInput.trim()
      await fetch('/api/config/presets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, searchTarget: { industry: actualIndustry, area, keywords: activeKeywords, maxResults } }),
      })
      const r = await fetch('/api/config/presets')
      const d = await r.json()
      if (d.success) setPresets(d.data)
    } finally {
      setSavingPreset(false)
      setPresetNameInput('')
      setShowPresetNameInput(false)
      setShowPresets(false)
    }
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
        <div className="relative" ref={presetDropdownRef}>
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
                {showPresetNameInput ? (
                  <div className="flex gap-1">
                    <input
                      type="text"
                      value={presetNameInput}
                      onChange={(e) => setPresetNameInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitSavePreset(); if (e.key === 'Escape') { setShowPresetNameInput(false); setPresetNameInput('') } }}
                      placeholder="プリセット名..."
                      autoFocus
                      className="flex-1 text-xs border border-gray-300 rounded px-2 py-1 focus:outline-none focus:border-blue-400"
                    />
                    <button
                      onClick={commitSavePreset}
                      disabled={savingPreset || !presetNameInput.trim()}
                      className="text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded px-2 py-1 transition-colors"
                    >
                      {savingPreset ? '...' : '保存'}
                    </button>
                  </div>
                ) : (
                  <button onClick={() => setShowPresetNameInput(true)} className="text-xs text-blue-600 hover:text-blue-800">
                    現在の設定を保存
                  </button>
                )}
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

      {/* Search params */}
      <div className="space-y-3">
      <div className="grid gap-3 grid-cols-1 sm:grid-cols-2">
        {/* Industry — free text */}
        <div className="relative" ref={industrySuggestRef}>
          <label className="block text-xs text-gray-500 mb-1 flex items-center gap-1">
            <Briefcase className="w-3 h-3" />業種
          </label>
          <input
            ref={industryInputRef}
            type="text"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            onFocus={() => { if (industrySuggestions.length > 0) setShowIndustrySuggestions(true) }}
            placeholder="例: 美容室、整骨院、歯科医院..."
            disabled={isRunning}
            className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none disabled:opacity-50"
          />
          {showIndustrySuggestions && industrySuggestions.length > 0 && (
            <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded shadow-md max-h-48 overflow-y-auto">
              {industrySuggestions
                .filter((s) => s.toLowerCase().includes(industry.toLowerCase()) || industry === '')
                .slice(0, 8)
                .map((s) => (
                  <button key={s} type="button"
                    onMouseDown={(e) => { e.preventDefault(); setIndustry(s); setShowIndustrySuggestions(false) }}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    {s}
                  </button>
                ))}
            </div>
          )}
        </div>

        {/* Area — free text with validation */}
        <div className="relative" ref={areaSuggestRef}>
          <label className="block text-xs text-gray-500 mb-1 flex items-center gap-1">
            <MapPin className="w-3 h-3" />エリア
          </label>
          <div className="relative">
            <input
              ref={areaInputRef}
              type="text"
              value={areaInput}
              onChange={(e) => { setAreaInput(e.target.value); setAreaValid(null) }}
              onFocus={() => { if (areaSuggestions.length > 0) setShowAreaSuggestions(true) }}
              placeholder="例: 渋谷区、新宿駅周辺、横浜市..."
              disabled={isRunning}
              className={`w-full bg-white border rounded px-3 py-2 text-sm text-gray-900 focus:outline-none disabled:opacity-50 ${
                areaError ? 'border-red-400 focus:border-red-400' :
                areaValid === true ? 'border-green-400 focus:border-green-400' :
                'border-gray-300 focus:border-blue-500'
              }`}
            />
            <div className="absolute right-2 top-1/2 -translate-y-1/2">
              {areaValidating && <Loader2 className="w-3.5 h-3.5 text-gray-400 animate-spin" />}
              {!areaValidating && areaValid === true && <span className="text-green-500 text-xs">✓</span>}
            </div>
          </div>
          {areaError && <p className="mt-1 text-xs text-red-500">{areaError}</p>}
          {showAreaSuggestions && areaSuggestions.length > 0 && (
            <div className="absolute z-20 top-full mt-1 left-0 right-0 bg-white border border-gray-200 rounded shadow-md max-h-48 overflow-y-auto">
              {areaSuggestions
                .filter((s) => s.toLowerCase().includes(areaInput.toLowerCase()) || areaInput === '')
                .slice(0, 8)
                .map((s) => (
                  <button key={s} type="button"
                    onMouseDown={(e) => { e.preventDefault(); setAreaInput(s); setShowAreaSuggestions(false) }}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    {s}
                  </button>
                ))}
            </div>
          )}
        </div>
      </div>{/* end inner grid */}

      {/* Keywords section — full width */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs text-gray-500 flex items-center gap-1">
            <Sparkles className="w-3 h-3" />
            検索キーワード
          </label>
          {keywordsLoading
            ? <span className="text-xs text-blue-400 flex items-center gap-1"><Loader2 className="w-3 h-3 animate-spin" />AI生成中...</span>
            : <span className="text-xs text-gray-400">{keywords.length}個</span>
          }
        </div>
        <div className={`flex flex-wrap gap-1 min-h-[34px] bg-white border rounded px-2 py-1.5 transition-colors ${isRunning ? 'border-gray-200 opacity-60' : 'border-gray-300'}`}>
          {keywords.map((kw) => (
            <span key={kw} className="inline-flex items-center gap-0.5 bg-blue-50 text-blue-700 text-xs px-2 py-0.5 rounded border border-blue-100">
              {kw}
              {!isRunning && (
                <button
                  onClick={() => setKeywords((prev) => prev.filter((k) => k !== kw))}
                  className="hover:text-blue-900 ml-0.5"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </span>
          ))}
          {!isRunning && (
            <input
              value={kwInput}
              onChange={(e) => setKwInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ',') && kwInput.trim()) {
                  e.preventDefault()
                  const kw = kwInput.trim().replace(/,$/, '')
                  if (kw && !keywords.includes(kw)) setKeywords((prev) => [...prev, kw])
                  setKwInput('')
                }
                if (e.key === 'Backspace' && !kwInput && keywords.length > 0) {
                  setKeywords((prev) => prev.slice(0, -1))
                }
              }}
              placeholder={keywords.length === 0 ? 'キーワードを入力 (Enter確定)' : '+ 追加'}
              className="text-xs outline-none flex-1 min-w-[80px] placeholder-gray-300"
            />
          )}
        </div>
        <p className="text-xs text-gray-400 mt-0.5">業種・エリア変更で自動再生成 · Enterで追加 · ×で削除</p>
        {suffixes.length > 0 && (
          <p className="text-xs text-orange-500 mt-0.5 flex items-center gap-1">
            <Sparkles className="w-3 h-3" />
            高密度エリアのため修飾語を追加: {suffixes.map(s => `「${s}」`).join(' ')}
          </p>
        )}
      </div>

      {/* Cost estimate + search provider */}
      <div className="flex items-center justify-between bg-gray-50 border border-gray-200 rounded px-3 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-gray-500">検索エンジン:</span>
            <button
              type="button"
              onClick={() => setSearchProvider('serper')}
              disabled={isRunning}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                searchProvider === 'serper'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
              }`}
            >
              Serper
            </button>
            <button
              type="button"
              onClick={() => setSearchProvider('places')}
              disabled={isRunning}
              className={`text-xs px-2 py-0.5 rounded border transition-colors ${
                searchProvider === 'places'
                  ? 'bg-blue-600 text-white border-blue-600'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'
              }`}
            >
              Google Places
            </button>
          </div>
          <div className="text-xs text-gray-700">
            概算コスト:&nbsp;
            <span className="font-semibold">
              ${estimateCost(keywords.length, selectedAreas, false, maxResults).toFixed(2)}
            </span>
          </div>
        </div>

      </div>{/* end space-y-3 */}

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
          >
            {isRunning ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> {status === 'queued' ? '待機中...' : '実行中...'}</>
            ) : (
              <><Play className="w-4 h-4" />
                {selectedAreas.length > 1
                  ? `${selectedAreas.length} エリア 実行開始`
                  : '実行開始'}
              </>
            )}
          </button>
          {!isRunning && (
            <span className="text-xs text-gray-400 select-none">⌘↵</span>
          )}
          {isRunning && currentRunIds.length > 0 && (
            <button
              onClick={handleCancel}
              disabled={canceling}
              className="flex items-center gap-1.5 text-xs text-red-600 hover:text-red-800 border border-red-300 hover:border-red-500 rounded px-2.5 py-1.5 transition-colors disabled:opacity-50"
            >
              {canceling ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3 fill-current" />}
              キャンセル
            </button>
          )}

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
              {liveCount.toLocaleString()}件 収集済み
            </span>
            {firstItemTimeRef.current && (() => {
              const elapsedMin = (Date.now() - firstItemTimeRef.current) / 60000
              const rate = elapsedMin > 0.1 ? Math.round(liveCount / elapsedMin) : null
              return rate !== null ? (
                <span className="text-blue-500 text-xs">· {rate.toLocaleString()}件/分</span>
              ) : null
            })()}
            <span className="text-blue-400 text-xs">（処理継続中）</span>
          </div>
        )}

        {/* Result summary */}
        {status === 'success' && itemsWritten > 0 && (
          <div className="flex items-center justify-between gap-2 bg-green-50 border border-green-200 rounded px-3 py-2">
            <div className="flex items-center gap-2">
              <Database className="w-3.5 h-3.5 text-green-600 flex-shrink-0" />
              <span className="text-green-700 text-xs font-medium">
                {itemsWritten.toLocaleString()}件 をプロジェクトに追加しました
              </span>
              {firstItemTimeRef.current && (() => {
                const elapsedMin = (Date.now() - firstItemTimeRef.current) / 60000
                const rate = elapsedMin > 0.5 ? Math.round(itemsWritten / elapsedMin) : null
                return rate !== null ? (
                  <span className="text-green-500 text-xs">({rate.toLocaleString()}件/分)</span>
                ) : null
              })()}
            </div>
            {selectedProjectId && (
              <button
                onClick={() => router.push(`/results/${selectedProjectId}`)}
                className="flex items-center gap-1 text-xs text-green-700 hover:text-green-900 border border-green-300 hover:border-green-500 rounded px-2 py-0.5 transition-colors flex-shrink-0"
              >
                <ExternalLink className="w-3 h-3" /> 結果を見る
              </button>
            )}
          </div>
        )}
      </div>
    </div>
    </>
  )
}
