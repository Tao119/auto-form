'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { LayoutDashboard, History, FolderOpen, Settings } from 'lucide-react'
import clsx from 'clsx'

const nav = [
  { href: '/dashboard', label: 'ダッシュボード', icon: LayoutDashboard },
  { href: '/history', label: '実行履歴', icon: History },
  { href: '/results', label: 'プロジェクト', icon: FolderOpen },
  { href: '/settings', label: '設定', icon: Settings },
]

export default function Sidebar() {
  const path = usePathname()

  return (
    <aside className="w-56 flex-shrink-0 bg-gray-900 border-r border-gray-700 flex flex-col">
      {/* Logo */}
      <div className="px-4 py-5 border-b border-gray-700">
        <div>
          <div className="text-sm font-bold text-white leading-tight">リスト収集ツール</div>
          <div className="text-xs text-gray-400 mt-0.5">REMEDY</div>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 py-3 px-2 space-y-0.5">
        {nav.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={clsx(
              'flex items-center gap-3 px-3 py-2 rounded text-sm transition-colors',
              path.startsWith(href)
                ? 'bg-gray-700 text-white font-medium'
                : 'text-gray-400 hover:bg-gray-800 hover:text-gray-200'
            )}
          >
            <Icon className="w-4 h-4 flex-shrink-0" />
            {label}
          </Link>
        ))}
      </nav>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-gray-700">
        <a
          href="http://localhost:5678"
          target="_blank"
          rel="noreferrer"
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          n8n UI →
        </a>
      </div>
    </aside>
  )
}
