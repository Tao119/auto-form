'use client'

import { useState, useEffect } from 'react'
import { Trash2, Plus, Save, ChevronDown, ChevronRight, ToggleLeft, ToggleRight } from 'lucide-react'
import type { Preset, SearchRun } from '@/lib/types'

export default function SettingsPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">設定</h1>
        <p className="text-sm text-gray-500 mt-1">プリセット管理・検索設定の編集</p>
      </div>
      <PresetsSection />
      <RunsSection />
    </div>
  )
}

/* ─── Presets Section ─────────────────────────────── */
function PresetsSection() {
  const [presets, setPresets] = useState<Preset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/config/presets')
      const d = await r.json()
      if (d.success) setPresets(d.data)
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleDelete = async (id: string) => {
    if (!confirm('このプリセットを削除しますか？')) return
    try {
      await fetch(`/api/config/presets?id=${id}`, { method: 'DELETE' })
      setPresets(presets.filter((p) => p.id !== id))
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <section className="bg-white rounded border border-gray-200 shadow-sm p-5">
      <h2 className="text-sm font-semibold text-gray-800 mb-4">プリセット一覧</h2>
      {error && <div className="text-red-600 text-sm mb-3">{error}</div>}
      {loading ? (
        <div className="text-gray-400 text-sm">読み込み中...</div>
      ) : presets.length === 0 ? (
        <div className="text-gray-400 text-sm">プリセットがありません。ダッシュボードから「現在の設定を保存」で追加できます。</div>
      ) : (
        <div className="space-y-2">
          {presets.map((p) => (
            <div key={p.id} className="flex items-center gap-3 bg-gray-50 rounded px-4 py-3 border border-gray-200">
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 text-sm">{p.name}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {p.searchTarget.industry} · {p.searchTarget.area} · {p.searchTarget.maxResults}件
                  {p.searchTarget.keywords.length > 0 && (
                    <span> · KW: {p.searchTarget.keywords.slice(0, 3).join(', ')}{p.searchTarget.keywords.length > 3 ? '...' : ''}</span>
                  )}
                </div>
                <div className="text-xs text-gray-400 mt-0.5">{new Date(p.createdAt).toLocaleString('ja-JP')}</div>
              </div>
              <button
                onClick={() => handleDelete(p.id)}
                className="p-1.5 text-gray-400 hover:text-red-500 transition-colors"
                title="削除"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

/* ─── Runs Section ────────────────────────────────── */
interface RunItemProps {
  run: SearchRun
  onToggle: (id: string) => void
  onDelete: (id: string) => void
}

function RunItem({ run, onToggle, onDelete }: RunItemProps) {
  const [open, setOpen] = useState(false)
  return (
    <div className="bg-gray-50 rounded border border-gray-200 overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={() => setOpen(!open)} className="text-gray-400 hover:text-gray-600">
          {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm text-gray-900">{run.label}</span>
          <span className="ml-2 text-xs text-gray-400">{run.id}</span>
        </div>
        <span className={`text-xs px-2 py-0.5 rounded border ${run.enabled ? 'bg-green-50 text-green-700 border-green-300' : 'bg-gray-100 text-gray-400 border-gray-300'}`}>
          {run.enabled ? '有効' : '無効'}
        </span>
        <button onClick={() => onToggle(run.id)} className="text-gray-400 hover:text-gray-600">
          {run.enabled
            ? <ToggleRight className="w-5 h-5 text-green-600" />
            : <ToggleLeft className="w-5 h-5 text-gray-400" />}
        </button>
        <button onClick={() => onDelete(run.id)} className="p-1 text-gray-400 hover:text-red-500">
          <Trash2 className="w-4 h-4" />
        </button>
      </div>
      {open && (
        <div className="border-t border-gray-200 px-4 py-3 space-y-2">
          {run.searchTargets.map((t, i) => (
            <div key={i} className="text-xs text-gray-500 bg-white rounded px-3 py-2 border border-gray-200">
              <span className="text-gray-800 font-medium">{t.industry}</span>
              {' / '}{t.area}{' / '}{t.maxResults}件
              {t.keywords.length > 0 && (
                <span className="ml-2 text-gray-400">KW: {t.keywords.join(', ')}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function RunsSection() {
  const [runs, setRuns] = useState<SearchRun[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showAdd, setShowAdd] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newIndustry, setNewIndustry] = useState('')
  const [newArea, setNewArea] = useState('東京都')
  const [newMax, setNewMax] = useState(50)
  const [saving, setSaving] = useState(false)

  const load = async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/config')
      const d = await r.json()
      if (d.success) setRuns(d.data.runs || [])
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleToggle = async (id: string) => {
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'toggle', id }),
      })
      const d = await r.json()
      if (d.success) setRuns(runs.map((run) => run.id === id ? { ...run, enabled: d.data.enabled } : run))
    } catch (e) {
      setError(String(e))
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('この実行設定を削除しますか？')) return
    try {
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove', id }),
      })
      const d = await r.json()
      if (d.success) setRuns(runs.filter((run) => run.id !== id))
    } catch (e) {
      setError(String(e))
    }
  }

  const handleAdd = async () => {
    if (!newLabel || !newIndustry) return
    setSaving(true)
    try {
      const keywords = [newIndustry]
      const r = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'add',
          run: {
            enabled: true,
            label: newLabel,
            searchTargets: [{ industry: newIndustry, area: newArea, keywords, maxResults: newMax }],
          },
        }),
      })
      const d = await r.json()
      if (d.success) {
        setRuns([...runs, d.data])
        setShowAdd(false)
        setNewLabel('')
        setNewIndustry('')
      } else {
        setError(d.error || '追加失敗')
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="bg-white rounded border border-gray-200 shadow-sm p-5">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-800">実行設定 (Runs)</h2>
        <button
          onClick={() => setShowAdd(!showAdd)}
          className="flex items-center gap-1 text-xs bg-white hover:bg-gray-50 text-gray-600 border border-gray-300 rounded px-3 py-1.5 transition-colors"
        >
          <Plus className="w-3 h-3" /> 追加
        </button>
      </div>

      {error && <div className="text-red-600 text-sm mb-3">{error}</div>}

      {showAdd && (
        <div className="bg-gray-50 rounded border border-gray-200 p-4 mb-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-gray-500 mb-1">ラベル</label>
              <input
                type="text"
                value={newLabel}
                onChange={(e) => setNewLabel(e.target.value)}
                placeholder="例: 東京 美容室"
                className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">業種</label>
              <input
                type="text"
                value={newIndustry}
                onChange={(e) => setNewIndustry(e.target.value)}
                placeholder="例: 美容室"
                className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">エリア</label>
              <input
                type="text"
                value={newArea}
                onChange={(e) => setNewArea(e.target.value)}
                className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">最大件数</label>
              <input
                type="number"
                value={newMax}
                onChange={(e) => setNewMax(parseInt(e.target.value) || 50)}
                min={1} max={200}
                className="w-full bg-white border border-gray-300 rounded px-3 py-2 text-sm text-gray-900 focus:border-blue-500 focus:outline-none"
              />
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <button
              onClick={() => setShowAdd(false)}
              className="text-xs text-gray-500 hover:text-gray-700 px-3 py-1.5"
            >
              キャンセル
            </button>
            <button
              onClick={handleAdd}
              disabled={saving || !newLabel || !newIndustry}
              className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-700 disabled:bg-gray-300 text-white rounded px-3 py-1.5 transition-colors"
            >
              <Save className="w-3 h-3" />
              {saving ? '保存中...' : '保存'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-gray-400 text-sm">読み込み中...</div>
      ) : runs.length === 0 ? (
        <div className="text-gray-400 text-sm">実行設定がありません</div>
      ) : (
        <div className="space-y-2">
          {runs.map((run) => (
            <RunItem key={run.id} run={run} onToggle={handleToggle} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </section>
  )
}
