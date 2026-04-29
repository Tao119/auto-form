import { NextResponse } from 'next/server'
import { hasToken } from '@/lib/google-auth'

export async function GET() {
  return NextResponse.json({ authed: hasToken() })
}
