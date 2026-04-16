export interface CompanyRow {
  id?: string  // SQLite primary key (not in legacy Sheets rows)
  '会社名': string
  'HP URL': string
  'フォームURL': string
  '電話番号': string
  'メールアドレス': string
  '住所': string
  'エリア': string
  '業種': string
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

// ─── Benchmark results ────────────────────────────────────────

export interface BenchmarkResults {
  totalCompanies: number      // L-02 Google Places total
  afterDedup: number          // after removing duplicates (already scraped)
  successCount: number        // HP fetch success
  errorCount: number          // HP fetch error
  formFoundCount: number      // companies with contact form detected
  formFoundRate: number       // formFoundCount / afterDedup * 100 (integer %)
  itemsWritten: number        // new rows written to Sheets (dedup against existing)
  elapsedMs: number           // total elapsed time
  avgMsPerItem: number        // elapsedMs / afterDedup
  subAreaCount?: number       // number of sub-areas searched
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
  status: 'pending' | 'running' | 'success' | 'completed' | 'error'
  itemsWritten?: number
  // Token / cost tracking
  tokensInput?: number
  tokensOutput?: number
  estimatedCostUsd?: number
  // Accuracy stats: Places API hit count vs final written count
  rawSearchCount?: number   // total places found by Google Places (before filtering)
  results?: BenchmarkResults
  // Queue
  queuePosition?: number  // 1-based position in waiting queue; undefined = not queued
  // Error info (populated when status = 'error')
  error?: string
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

export type SearchMode = 'prefecture' | 'radius'

export interface ExecuteParams {
  industry: string
  area: string
  areas?: string[]   // multi-area single-session mode
  keywords?: string[]
  maxResults?: number
  projectId: string
  runId: string
  // Radius (map-based) mode
  searchMode?: SearchMode
  lat?: number
  lng?: number
  radiusKm?: number
}

export interface ApiResponse<T> {
  success: boolean
  data?: T
  error?: string
}
