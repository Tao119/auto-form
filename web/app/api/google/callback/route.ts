import { NextRequest, NextResponse } from 'next/server'
import { exchangeCode } from '@/lib/google-auth'

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get('code')
  const state = req.nextUrl.searchParams.get('state') || ''  // projectId

  if (!code) {
    return NextResponse.redirect(new URL(`/results/${state}?sheets_error=no_code`, req.nextUrl.origin))
  }

  try {
    await exchangeCode(code)
    const redirect = state
      ? `/results/${state}?sheets_authed=1`
      : '/?sheets_authed=1'
    return NextResponse.redirect(new URL(redirect, req.nextUrl.origin))
  } catch (e) {
    const redirect = state
      ? `/results/${state}?sheets_error=${encodeURIComponent(String(e))}`
      : `/?sheets_error=${encodeURIComponent(String(e))}`
    return NextResponse.redirect(new URL(redirect, req.nextUrl.origin))
  }
}
