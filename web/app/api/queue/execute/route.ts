import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { enqueue, markJobActive, markJobDone } from '@/lib/run-queue'
import { addRunToProject, addBatchRunToProject, getProject } from '@/lib/project-manager'
import { triggerWorkflow } from '@/lib/n8n-client'
import type { ExecuteParams } from '@/lib/types'

const Schema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  label: z.string().min(1),
  industry: z.string().min(1),
  area: z.string().min(1),
  areas: z.array(z.string()).optional(),            // multi-area batch mode
  keywords: z.array(z.string()).optional(),
  suffixes: z.array(z.string()).optional(),          // AI判定で高密度エリア時のみ設定される検索修飾語
  maxResults: z.number().int().min(0).optional(),  // 0 = unlimited
  // Radius (map-based) mode
  searchMode: z.enum(['prefecture', 'radius']).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  radiusKm: z.number().min(1).max(200).optional(),
  searchProvider: z.enum(['serper', 'places']).optional(),
})

/**
 * POST /api/queue/execute
 * キューにジョブを追加し、枠があれば即座にn8nを起動する。
 * 満杯なら待機列に入る。
 *
 * areas が複数の場合 (都道府県モード)、バッチ親ランを1件生成し、
 * 各都道府県ごとに子ランを独立エンキューする。
 * 履歴には親ランだけが表示され、子ランは内部的に隠される。
 */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json())
    const { runId, projectId, label, ...execFields } = body

    // Verify project exists
    const project = await getProject(projectId)
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 })
    }

    const keywords = execFields.keywords ?? [execFields.industry]
    const suffixes = execFields.suffixes ?? []
    const maxResults = execFields.maxResults ?? 50
    const base = process.env.INTERNAL_BASE_URL || 'http://localhost:3003'

    // ── Batch mode: multiple prefectures → 1 parent + N child runs ──────────
    const isBatch = execFields.areas && execFields.areas.length > 1 && execFields.searchMode !== 'radius'

    if (isBatch) {
      const areas = execFields.areas!
      const timestamp = new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }).slice(0, 16)

      // Generate stable child IDs (index-offset to avoid millisecond collisions)
      const now = Date.now()
      const childDefs = areas.map((area, i) => ({
        id: `run-c${now + i}-${Math.random().toString(36).slice(2, 5)}`,
        area,
        label: `${execFields.industry} / ${area} ${timestamp}`,
      }))

      const { children } = await addBatchRunToProject(
        projectId,
        {
          id: runId,
          label,
          searchTarget: {
            industry: execFields.industry,
            area: label,
            areas,
            keywords,
            maxResults,
          },
        },
        childDefs,
      )

      // Enqueue each child independently (respects MAX_CONCURRENT)
      const childResults: { id: string; queued: boolean; queuePosition: number }[] = []
      let anyChildStarted = false

      for (const child of children) {
        const childParams: ExecuteParams = {
          industry: execFields.industry,
          area: child.searchTarget.area,
          keywords,
          ...(suffixes.length > 0 && { suffixes }),
          maxResults,
          projectId,
          runId: child.id,
          ...(execFields.searchProvider && { searchProvider: execFields.searchProvider }),
        }

        const { canStart, queuePosition } = await enqueue(child.id, projectId, childParams)

        if (canStart) {
          anyChildStarted = true
          await markJobActive(child.id)
          try {
            const result = await triggerWorkflow(childParams)
            fetch(`${base}/api/projects/runs/${child.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'running', n8nExecutionId: result.executionId }),
            }).catch(() => {})
          } catch (triggerErr) {
            await markJobDone(child.id, 'failed', String(triggerErr))
            fetch(`${base}/api/projects/runs/${child.id}`, {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ status: 'error' }),
            }).catch(() => {})
          }
        }

        childResults.push({ id: child.id, queued: !canStart, queuePosition })
      }

      // Promote batch parent to 'running' once at least one child has started
      if (anyChildStarted) {
        fetch(`${base}/api/projects/runs/${runId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'running' }),
        }).catch(() => {})
      }

      return NextResponse.json({
        success: true,
        batch: true,
        batchRunId: runId,
        childRunIds: children.map((c) => c.id),
        childResults,
      })
    }

    // ── Single-area (or radius) mode ────────────────────────────────────────
    const params: ExecuteParams = {
      industry: execFields.industry,
      area: execFields.area,
      keywords,
      ...(suffixes.length > 0 && { suffixes }),
      maxResults,
      projectId,
      runId,
      ...(execFields.searchMode === 'radius' && {
        searchMode: 'radius',
        lat: execFields.lat,
        lng: execFields.lng,
        radiusKm: execFields.radiusKm,
      }),
      ...(execFields.searchProvider && { searchProvider: execFields.searchProvider }),
    }

    // Register run in project (include radius fields so retry can reproduce exact conditions)
    await addRunToProject(projectId, {
      id: runId,
      label,
      searchTarget: {
        industry: execFields.industry,
        area: execFields.area,
        keywords,
        maxResults,
        ...(execFields.searchMode === 'radius' && {
          searchMode: 'radius' as const,
          lat: execFields.lat,
          lng: execFields.lng,
          radiusKm: execFields.radiusKm,
        }),
      },
    })

    // Enqueue (file-based)
    const { canStart, queuePosition } = await enqueue(runId, projectId, params)

    if (!canStart) {
      return NextResponse.json({
        success: true,
        queued: true,
        queuePosition,
        message: `キュー待機中 (${queuePosition}番目)`,
      })
    }

    // Start immediately
    await markJobActive(runId)

    try {
      const result = await triggerWorkflow(params)
      // Update run status to running
      await fetch(`${base}/api/projects/runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'running', n8nExecutionId: result.executionId }),
      }).catch(() => {})

      return NextResponse.json({
        success: true,
        queued: false,
        executionId: result.executionId,
      })
    } catch (triggerErr) {
      // Trigger failed — mark queue job as failed so it doesn't block the queue
      await markJobDone(runId, 'failed', String(triggerErr))
      await fetch(`${base}/api/projects/runs/${runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'error' }),
      }).catch(() => {})
      throw triggerErr
    }
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
