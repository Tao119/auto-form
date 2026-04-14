export interface CompanyRow {
  '会社名': string
  'HP URL': string
  'フォームURL': string
  '電話番号': string
  'メールアドレス': string
  '住所': string
  '業種': string
  'エリア': string
  'フォーム種別': string
  '収集日時': string
  'ステータス': string
  '備考': string
  'プロジェクトID': string
  '実行ID': string
}

export interface SearchTarget {
  industry: string
  area: string
  keywords: string[]
  maxResults: number
}

export interface SearchRun {
  id: string
  enabled: boolean
  label: string
  searchTargets: SearchTarget[]
}

export interface SearchConfig {
  _comment?: string
  runs: SearchRun[]
  areaExpansion: Record<string, string[]>
  formDetection?: {
    contactPageKeywords?: string[]
    bookingPageKeywords?: string[]
    formSelectors?: string[]
  }
  sheetsColumns?: Record<string, string>
}

export interface Preset {
  id: string
  name: string
  createdAt: string
  searchTarget: SearchTarget
}

// ─── Project types ────────────────────────────────────────────

export interface Project {
  id: string          // proj-YYYYMMDD-NNN
  name: string
  description?: string
  createdAt: string
  runIds: string[]    // ordered list of run IDs
}

export interface ProjectRun {
  id: string          // run-{timestamp}-{random}
  projectId: string
  label: string       // "美容室 / 東京都 2026-04-15 09:30"
  createdAt: string
  completedAt?: string
  searchTarget: SearchTarget
  n8nExecutionId?: string
  status: 'pending' | 'running' | 'success' | 'error'
  itemsWritten?: number
  // Token / cost tracking
  tokensInput?: number
  tokensOutput?: number
  estimatedCostUsd?: number
  // Accuracy stats: Places API hit count vs final written count
  rawSearchCount?: number   // total places found by Google Places (before filtering)
  // Queue
  queuePosition?: number  // 1-based position in waiting queue; undefined = not queued
}

// ─── Queue types ──────────────────────────────────────────────

export type QueueJobStatus = 'waiting' | 'active' | 'completed' | 'failed'

export interface QueueJob {
  runId: string
  projectId: string
  params: ExecuteParams
  status: QueueJobStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  error?: string
}

export interface QueueData {
  jobs: QueueJob[]
  maxConcurrent: number
}

export interface ProjectsData {
  projects: Project[]
  runs: ProjectRun[]
}

// ─── n8n types ────────────────────────────────────────────────

export interface N8nExecution {
  id: string
  finished: boolean
  mode: string
  status: 'success' | 'error' | 'running' | 'waiting' | 'canceled'
  startedAt: string
  stoppedAt: string | null
  workflowId: string
  data?: {
    resultData?: {
      runData?: Record<string, unknown[]>
    }
  }
}

export interface ExecuteParams {
  industry: string
  area: string
  keywords?: string[]
  maxResults?: number
  projectId: string
  runId: string
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}
