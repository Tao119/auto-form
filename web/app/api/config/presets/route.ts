import { NextRequest, NextResponse } from 'next/server'
import { getPresets, savePreset, deletePreset } from '@/lib/preset-manager'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const presets = getPresets()
    return NextResponse.json({ success: true, data: presets })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { name, searchTarget } = await req.json()
    if (!name || !searchTarget) {
      return NextResponse.json({ success: false, error: 'name and searchTarget required' }, { status: 400 })
    }
    const preset = savePreset(name, searchTarget)
    return NextResponse.json({ success: true, data: preset })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const id = req.nextUrl.searchParams.get('id')
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 })
    deletePreset(id)
    return NextResponse.json({ success: true })
  } catch (e) {
    return NextResponse.json({ success: false, error: String(e) }, { status: 400 })
  }
}
