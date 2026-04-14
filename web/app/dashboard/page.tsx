export const dynamic = 'force-dynamic'

import { getSheetStats } from '@/lib/sheets-client'
import { listExecutions } from '@/lib/n8n-client'
import ExecutePanel from '@/components/dashboard/execute-panel'
import { Users, CheckCircle, Clock, AlertCircle } from 'lucide-react'

const emptySheet = { total: 0, byStatus: {} as Record<string, number> }

async function getStats() {
  try {
    const [sheetStats, execResult] = await Promise.allSettled([
      getSheetStats(),
      listExecutions(10),
    ])

    const sheet = sheetStats.status === 'fulfilled' ? sheetStats.value : emptySheet
    const execs = execResult.status === 'fulfilled' ? execResult.value.data : []
    const lastExec = execs?.[0]
    const successCount = execs?.filter((e) => e.status === 'success').length ?? 0

    return { sheet, lastExec, successCount, recentCount: execs?.length ?? 0 }
  } catch {
    return { sheet: emptySheet, lastExec: null, successCount: 0, recentCount: 0 }
  }
}

export default async function DashboardPage() {
  const { sheet, lastExec, successCount, recentCount } = await getStats()

  const cards = [
    {
      label: '収集済み企業数',
      value: sheet.total.toLocaleString(),
      sub: `未送信: ${sheet.byStatus['未送信'] ?? 0}件`,
      icon: Users,
      iconCls: 'text-blue-600',
    },
    {
      label: '送信済み',
      value: (sheet.byStatus['送信済み'] ?? 0).toLocaleString(),
      sub: 'ステータス更新済み',
      icon: CheckCircle,
      iconCls: 'text-green-600',
    },
    {
      label: '直近10回の成功',
      value: `${successCount} / ${recentCount}`,
      sub: '実行',
      icon: Clock,
      iconCls: 'text-yellow-600',
    },
    {
      label: 'エラー',
      value: (sheet.byStatus['エラー'] ?? 0).toLocaleString(),
      sub: '件',
      icon: AlertCircle,
      iconCls: 'text-red-500',
    },
  ]

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-gray-900">ダッシュボード</h1>
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
