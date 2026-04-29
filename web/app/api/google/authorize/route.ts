import { NextRequest, NextResponse } from 'next/server'
import { getAuthUrl } from '@/lib/google-auth'

export async function GET(req: NextRequest) {
  const projectId = req.nextUrl.searchParams.get('projectId') || ''
  const url = getAuthUrl(projectId)
  return NextResponse.redirect(url)
}
