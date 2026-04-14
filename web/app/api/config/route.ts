import { NextRequest, NextResponse } from 'next/server'
import { getConfig, updateConfig, addRun, removeRun, toggleRun } from '@/lib/config-manager'

export async function GET() {
  try {
    const config = getConfig()
    return NextResponse.json({ success: true, data: config })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

export async function PUT(req: NextRequest) {
  try {
    const config = await req.json()
    updateConfig(config)
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { action, id, run } = await req.json()
    if (action === 'add') {
      const newRun = addRun(run)
      return NextResponse.json({ success: true, run: newRun })
    }
    if (action === 'remove') {
      removeRun(id)
      return NextResponse.json({ success: true })
    }
    if (action === 'toggle') {
      const enabled = toggleRun(id)
      return NextResponse.json({ success: true, enabled })
    }
    return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
