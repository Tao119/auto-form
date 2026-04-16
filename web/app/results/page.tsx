'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { FolderOpen, Plus, Trash2, ChevronRight, RefreshCw } from 'lucide-react'
import type { Project } from '@/lib/types'
import { ProjectCreateModal } from '@/components/modals/project-create-modal'

interface ProjectWithMeta extends Project {
  runCount: number
  companyCount?: number
  formFoundCount?: number
}

export default function ResultsPage() {
  const router = useRouter()
  const [projects, setProjects] = useState<ProjectWithMeta[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showCreateModal, setShowCreateModal] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = async () => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch('/api/projects')
      const data = await res.json()
      if (data.success) setProjects(data.data)
      else setError(data.error || 'プロジェクト取得失敗')
    } catch (e) {
      setError(String(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`プロジェクト「${name}」を削除しますか？\n関連する実行履歴も全て削除されます。`)) return
    setDeleting(id)
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' })
      await load()
    } catch (e) {
      setError(String(e))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <>
    <ProjectCreateModal
      open={showCreateModal}
      onClose={() => setShowCreateModal(false)}
      onCreate={(project) => {
        setProjects((prev) => [{ ...project, runCount: 0 }, ...prev])
      }}
    />
    <div className="p-6 space-y-4 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">プロジェクト</h1>
          <p className="text-sm text-gray-500 mt-1">
            {loading ? '読み込み中...' : `${projects.length}件のプロジェクト`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={load}
            disabled={loading}
            className="flex items-center gap-1 text-xs text-gray-500 hover:text-gray-700 border border-gray-300 rounded px-2 py-1.5 transition-colors disabled:opacity-50 bg-white"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
            更新
          </button>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-700 text-white rounded px-3 py-1.5 transition-colors"
          >
            <Plus className="w-3 h-3" />
            新規プロジェクト
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {/* Project list */}
      <div className="flex-1 overflow-auto space-y-2">
        {loading && projects.length === 0 && (
          <div className="flex items-center justify-center py-20">
            <RefreshCw className="w-5 h-5 animate-spin text-gray-400" />
          </div>
        )}

        {!loading && projects.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-400">
            <FolderOpen className="w-10 h-10 mb-3 opacity-40" />
            <p className="text-sm">プロジェクトがありません</p>
            <p className="text-xs mt-1">「新規プロジェクト」で作成してください</p>
          </div>
        )}

        {projects.map((proj) => (
          <div
            key={proj.id}
            className="bg-white rounded border border-gray-200 hover:border-gray-300 shadow-sm transition-colors group"
          >
            <div className="p-4">
              <div className="flex items-start justify-between gap-4">
                {/* Left: Info */}
                <button
                  onClick={() => router.push(`/results/${proj.id}`)}
                  className="flex-1 text-left group/card"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <FolderOpen className="w-4 h-4 text-gray-400 flex-shrink-0" />
                    <span className="text-sm font-medium text-gray-900 group-hover/card:text-blue-600 transition-colors">
                      {proj.name}
                    </span>
                    {proj.industry && (
                      <span className="text-xs px-1.5 py-0.5 bg-blue-50 text-blue-700 border border-blue-200 rounded">
                        {proj.industry}
                      </span>
                    )}
                    <ChevronRight className="w-3.5 h-3.5 text-gray-300 group-hover/card:text-gray-500 transition-colors" />
                  </div>
                  {proj.description && (
                    <p className="text-xs text-gray-500 mb-2 ml-6">{proj.description}</p>
                  )}
                  <div className="flex items-center gap-4 ml-6 text-xs text-gray-400">
                    <span>{proj.runCount}回の実行</span>
                    {proj.companyCount !== undefined && proj.companyCount > 0 && (
                      <span className="text-gray-600">
                        {proj.companyCount.toLocaleString()}社収集
                        {proj.formFoundCount !== undefined && proj.formFoundCount > 0 && (
                          <span className="ml-1 text-green-600">
                            (フォーム {Math.round((proj.formFoundCount / proj.companyCount) * 100)}%)
                          </span>
                        )}
                      </span>
                    )}
                    <span>{new Date(proj.createdAt).toLocaleDateString('ja-JP')}</span>
                  </div>
                </button>

                {/* Right: Actions */}
                <button
                  onClick={() => handleDelete(proj.id, proj.name)}
                  disabled={deleting === proj.id}
                  className="opacity-0 group-hover:opacity-100 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-all disabled:opacity-50"
                  title="削除"
                >
                  {deleting === proj.id
                    ? <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    : <Trash2 className="w-3.5 h-3.5" />
                  }
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
    </>
  )
}
