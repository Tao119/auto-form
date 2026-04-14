import type { N8nExecution, ExecuteParams } from './types'

const BASE_URL = process.env.N8N_BASE_URL || 'http://localhost:5678'
const API_KEY = process.env.N8N_API_KEY || ''
const WORKFLOW_ID = process.env.N8N_WORKFLOW_ID || ''
const WEBHOOK_PATH = process.env.N8N_WEBHOOK_PATH || 'list-collect'

function headers() {
  return {
    'X-N8N-API-KEY': API_KEY,
    'Content-Type': 'application/json',
  }
}

export async function triggerWorkflow(params: ExecuteParams): Promise<{ executionId?: string }> {
  const webhookUrl = `${BASE_URL}/webhook/${WEBHOOK_PATH}`
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Webhook failed: ${res.status} ${text}`)
  }

  const data = await res.json().catch(() => ({}))
  return { executionId: data.executionId || data.id }
}

export async function getExecution(executionId: string): Promise<N8nExecution> {
  const res = await fetch(`${BASE_URL}/api/v1/executions/${executionId}`, {
    headers: headers(),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) throw new Error(`Failed to get execution: ${res.status}`)
  return res.json()
}

export async function listExecutions(limit = 30): Promise<{ data: N8nExecution[]; nextCursor?: string }> {
  const params = new URLSearchParams({
    limit: String(limit),
    ...(WORKFLOW_ID ? { workflowId: WORKFLOW_ID } : {}),
  })

  const res = await fetch(`${BASE_URL}/api/v1/executions?${params}`, {
    headers: headers(),
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  })

  if (!res.ok) throw new Error(`Failed to list executions: ${res.status}`)
  return res.json()
}

export async function checkN8nHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE_URL}/healthz`, { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch {
    return false
  }
}
