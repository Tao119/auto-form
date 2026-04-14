import type { Metadata } from 'next'
import './globals.css'
import Sidebar from '@/components/layout/sidebar'

export const metadata: Metadata = {
  title: 'リスト収集ツール',
  description: '企業フォーム自動探索システム',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="flex h-screen overflow-hidden bg-gray-100 text-gray-900">
        <Sidebar />
        <main className="flex-1 overflow-y-auto scrollbar-thin">
          {children}
        </main>
      </body>
    </html>
  )
}
