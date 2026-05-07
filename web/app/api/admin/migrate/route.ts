import { NextResponse } from 'next/server'
import { runMigrations } from '@/lib/db-migrate'

export const dynamic = 'force-dynamic'

export async function POST() {
  try {
    await runMigrations()
    return NextResponse.json({ success: true, message: 'Migrations completed' })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}
