export const dynamic = 'force-dynamic'

import { getSheetStats } from '@/lib/sheets-client'
import { listExecutions, checkN8nHealth } from '@/lib/n8n-client'
import ExecutePanel from '@/components/dashboard/execute-panel'
import { Users, CheckCircle, Clock, Link2, Wifi, WifiOff } from 'lucide-react'

const emptySheet = { total: 0, formFoundCount: 0, byStatus: {} as Record<string, number>, byFormType: {} as Record<string, number> }

async function getStats() {
  try {
    const [sheetStats, execResult, n8nHealthResult] = await Promise.allSettled([
      getSheetStats(),
      listExecutions(10),
      checkN8nHealth(),
    ])

    const sheet = sheetStats.status === 'fulfilled' ? sheetStats.value : emptySheet
    const execs = execResult.status === 'fulfilled' ? execResult.value.data : []
    const lastExec = execs?.[0]
    const successCount = execs?.filter((e) => e.status === 'success').length ?? 0
    const n8nHealthy = n8nHealthResult.status === 'fulfilled' ? n8nHealthResult.value : false

    return { sheet, lastExec, successCount, recentCount: execs?.length ?? 0, n8nHealthy }
  } catch {
    return { sheet: emptySheet, lastExec: null, successCount: 0, recentCount: 0, n8nHealthy: false }
  }
}

export default async function DashboardPage() {
  const { sheet, lastExec, successCount, recentCount, n8nHealthy } = await getStats()

  const formRate = sheet.total > 0
    ? Math.round((sheet.formFoundCount / sheet.total) * 100)
    : 0

  const cards = [
    {
      label: '収集済み企業数',
      value: sheet.total.toLocaleString(),
      sub: `未送信: ${(sheet.byStatus['未送信'] ?? 0).toLocaleString()}件`,
      icon: Users,
      iconCls: 'text-blue-600',
    },
    {
      label: 'フォームURL発見',
      value: sheet.formFoundCount.toLocaleString(),
      sub: `発見率 ${formRate}%`,
      icon: Link2,
      iconCls: 'text-green-600',
    },
    {
      label: '直近10回の成功',
      value: `${successCount} / ${recentCount}`,
      sub: 'n8n 実行',
      icon: Clock,
      iconCls: 'text-yellow-600',
    },
    {
      label: '送信済み',
      value: (sheet.byStatus['送信済み'] ?? 0).toLocaleString(),
      sub: `全体の${sheet.total > 0 ? Math.round(((sheet.byStatus['送信済み'] ?? 0) / sheet.total) * 100) : 0}%`,
      icon: CheckCircle,
      iconCls: 'text-purple-600',
    },
  ]

  return (
    <div className="p-6 space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold text-gray-900">ダッシュボード</h1>
          <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded border ${
            n8nHealthy
              ? 'bg-green-50 text-green-700 border-green-200'
              : 'bg-red-50 text-red-700 border-red-200'
          }`}>
            {n8nHealthy
              ? <><Wifi className="w-3 h-3" /> n8n 接続中</>
              : <><WifiOff className="w-3 h-3" /> n8n 未接続</>}
          </span>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          {lastExec
            ? `最終実行: ${new Date(lastExec.startedAt).toLocaleString('ja-JP')} — ${lastExec.status}`
            : '実行履歴なし'}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {cards.map(({ label, value, sub, icon: Icon, iconCls }) => (
          <div key={label} className="bg-white rounded border border-gray-200 p-4 shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-gray-500">{label}</span>
              <Icon className={`w-4 h-4 ${iconCls}`} />
            </div>
            <div className="text-2xl font-bold text-gray-900">{value}</div>
            <div className="text-xs text-gray-400 mt-1">{sub}</div>
          </div>
        ))}
      </div>

      {/* Execute Panel */}
      <ExecutePanel />
    </div>
  )
}
