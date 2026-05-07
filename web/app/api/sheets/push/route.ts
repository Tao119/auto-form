import { NextRequest, NextResponse } from 'next/server'
import { google } from 'googleapis'
import { z } from 'zod'
import { getAuthedClient } from '@/lib/google-auth'
import { getProject, getRunsForProject, getProjectRun } from '@/lib/project-manager'
import { getCompanies } from '@/lib/companies-db'
import { COLUMNS } from '@/lib/sheets-client'
import type { Company } from '@/lib/companies-db'
import type { ProjectRun } from '@/lib/types'

const Schema = z.object({
  projectId: z.string().min(1),
  runId: z.string().optional(),
})

function toRow(c: Company): string[] {
  return [
    c.name, c.hpUrl, c.formUrl, c.phone, c.email,
    c.address, c.industry, c.area, c.formType,
    c.collectedAt, c.status, c.notes, c.projectId, c.runId,
  ]
}

/** Sanitize a run label into a valid sheet tab title (max 100 chars, no special chars). */
function toTabTitle(label: string): string {
  return label.replace(/[\\/?*[\]:]/g, '_').slice(0, 100)
}

async function ensureSheet(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  existingTitles: string[],
  title: string,
): Promise<void> {
  if (!existingTitles.includes(title)) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title } } }] },
    })
    existingTitles.push(title)
  }
}

async function writeTab(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  title: string,
  rows: string[][],
): Promise<void> {
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${title}'!A:Z`,
  })
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: [COLUMNS, ...rows] },
  })
}

/**
 * POST /api/sheets/push
 *
 * runId なし (PJエクスポート):
 *   - 「全件」タブ: 全プロジェクトデータ
 *   - 各runのラベル名タブ: そのrunのデータ（バッチ親runは子run含む）
 *
 * runId あり (個別runエクスポート):
 *   - そのrunのラベル名タブ: runのデータ
 *   - 「全件」タブ: 全プロジェクトデータを更新
 */
export async function POST(req: NextRequest) {
  try {
    const { projectId, runId } = Schema.parse(await req.json())
    const project = await getProject(projectId)
    if (!project) return NextResponse.json({ success: false, error: 'Project not found' }, { status: 404 })
    if (!project.sheetsId) return NextResponse.json({ success: false, error: 'スプレッドシート未連携' }, { status: 400 })

    const auth = getAuthedClient()
    const sheets = google.sheets({ version: 'v4', auth })
    const sheetsId = project.sheetsId

    // Fetch existing sheet titles once
    const meta = await sheets.spreadsheets.get({ spreadsheetId: sheetsId })
    const existingTitles: string[] = (meta.data.sheets || []).map((s) => s.properties?.title || '')

    if (runId) {
      // ── Single-run export ──────────────────────────────────────
      const run = (await getProjectRun(runId)) as (ProjectRun & { childRunIds?: string[] }) | undefined
      const tabTitle = run ? toTabTitle(run.label) : toTabTitle(runId)

      // Collect data: for batch parents, include all child run data
      let companies
      if (run?.childRunIds?.length) {
        companies = await getCompanies({ runIds: [runId, ...run.childRunIds] })
      } else {
        companies = await getCompanies({ runId })
      }
      const rows = companies.map(toRow)

      await ensureSheet(sheets, sheetsId, existingTitles, tabTitle)
      await writeTab(sheets, sheetsId, tabTitle, rows)

      // Update 全件 tab
      const allCompanies = await getCompanies({ projectId })
      const allRows = allCompanies.map(toRow)
      await ensureSheet(sheets, sheetsId, existingTitles, '全件')
      await writeTab(sheets, sheetsId, '全件', allRows)

      return NextResponse.json({
        success: true,
        written: rows.length,
        totalWritten: allRows.length,
        url: `https://docs.google.com/spreadsheets/d/${sheetsId}`,
      })
    }

    // ── Full project export ────────────────────────────────────────
    // Write 全件 tab first
    const allCompanies = await getCompanies({ projectId })
    const allRows = allCompanies.map(toRow)
    await ensureSheet(sheets, sheetsId, existingTitles, '全件')
    await writeTab(sheets, sheetsId, '全件', allRows)

    // Write one tab per top-level run (exclude child runs)
    const projectRuns = (await getRunsForProject(projectId)) as (ProjectRun & { childRunIds?: string[]; parentRunId?: string })[]
    const topLevelRuns = projectRuns.filter((r) => !r.parentRunId)

    for (const run of topLevelRuns) {
      const tabTitle = toTabTitle(run.label)
      let runCompanies
      if (run.childRunIds?.length) {
        runCompanies = await getCompanies({ runIds: [run.id, ...run.childRunIds] })
      } else {
        runCompanies = await getCompanies({ runId: run.id })
      }
      const runRows = runCompanies.map(toRow)
      await ensureSheet(sheets, sheetsId, existingTitles, tabTitle)
      await writeTab(sheets, sheetsId, tabTitle, runRows)
    }

    return NextResponse.json({
      success: true,
      written: allRows.length,
      totalWritten: allRows.length,
      tabCount: topLevelRuns.length + 1,
      url: `https://docs.google.com/spreadsheets/d/${sheetsId}`,
    })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const status = msg.includes('未認証') ? 401 : 500
    return NextResponse.json({ success: false, error: msg }, { status })
  }
}
