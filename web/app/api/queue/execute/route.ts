import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { enqueue, markJobActive, markJobDone } from '@/lib/run-queue'
import { addRunToProject, getProject } from '@/lib/project-manager'
import { triggerWorkflow } from '@/lib/n8n-client'
import type { ExecuteParams } from '@/lib/types'

const Schema = z.object({
  runId: z.string().min(1),
  projectId: z.string().min(1),
  label: z.string().min(1),
  industry: z.string().min(1),
  area: z.string().min(1),
  areas: z.array(z.string()).optional(),            // multi-area single-session
  keywords: z.array(z.string()).optional(),
  maxResults: z.number().int().min(0).optional(),  // 0 = unlimited
  // Radius (map-based) mode
  searchMode: z.enum(['prefecture', 'radius']).optional(),
  lat: z.number().optional(),
  lng: z.number().optional(),
  radiusKm: z.number().min(1).max(200).optional(),
})

/**
 * POST /api/queue/execute
 * キューにジョブを追加し、枠があれば即座にn8nを起動する。
 * 満杯なら待機列に入る。
 */
export async function POST(req: NextRequest) {
  try {
    const body = Schema.parse(await req.json())
    const { runId, projectId, label, ...execFields } = body

    // Verify project exists
    const project = getProject(projectId)
    if (!project) {
      return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 })
    }

    const keywords = execFields.keywords ?? [execFields.industry]
    const maxResults = execFields.maxResults ?? 50

    const params: ExecuteParams = {
      industry: execFields.industry,
      area: execFields.area,
      ...(execFields.areas && execFields.areas.length > 1 && { areas: execFields.areas }),
      keywords,
      maxResults,
      projectId,
      runId,
      ...(execFields.searchMode === 'radius' && {
        searchMode: 'radius',
        lat: execFields.lat,
        lng: execFields.lng,
        radiusKm: execFields.radiusKm,
      }),
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
    const { canStart, queuePosition } = enqueue(runId, projectId, params)

    if (!canStart) {
      // Update run status to reflect queue position
      return NextResponse.json({
        success: true,
        queued: true,
        queuePosition,
        message: `キュー待機中 (${queuePosition}番目)`,
      })
    }

    // Start immediately
    markJobActive(runId)

    try {
      const result = await triggerWorkflow(params)
      // Update run status to running
      await fetch(
        `${process.env.INTERNAL_BASE_URL || 'http://localhost:3003'}/api/projects/runs/${runId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'running', n8nExecutionId: result.executionId }),
        }
      ).catch(() => {})

      return NextResponse.json({
        success: true,
        queued: false,
        executionId: result.executionId,
      })
    } catch (triggerErr) {
      // Trigger failed — mark queue job as failed so it doesn't block the queue
      markJobDone(runId, 'failed', String(triggerErr))
      await fetch(
        `${process.env.INTERNAL_BASE_URL || 'http://localhost:3003'}/api/projects/runs/${runId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: 'error' }),
        }
      ).catch(() => {})
      throw triggerErr
    }
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
