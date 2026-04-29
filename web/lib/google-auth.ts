import { google } from 'googleapis'
import fs from 'fs'
import path from 'path'

const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(process.cwd(), '../config')
const TOKEN_PATH = path.join(CONFIG_DIR, 'oauth2-token.json')
const CREDS_PATH = path.join(CONFIG_DIR, 'oauth2-credentials.json')

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
]

function getRedirectUri() {
  const base = process.env.INTERNAL_BASE_URL || 'http://localhost:3003'
  return `${base}/api/google/callback`
}

export function getOAuth2Client() {
  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'))
  const { client_id, client_secret } = creds.installed || creds.web
  return new google.auth.OAuth2(client_id, client_secret, getRedirectUri())
}

export function getAuthUrl(state?: string): string {
  const client = getOAuth2Client()
  return client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state,
  })
}

export function hasToken(): boolean {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return false
    const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
    return !!(token.access_token || token.refresh_token)
  } catch { return false }
}

export function getAuthedClient() {
  if (!hasToken()) throw new Error('Google未認証')
  const client = getOAuth2Client()
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
  client.setCredentials(token)
  client.on('tokens', (newTokens) => {
    try {
      const current = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf-8'))
      fs.writeFileSync(TOKEN_PATH, JSON.stringify({ ...current, ...newTokens }, null, 2))
    } catch {}
  })
  return client
}

export async function exchangeCode(code: string) {
  const client = getOAuth2Client()
  const { tokens } = await client.getToken(code)
  fs.mkdirSync(CONFIG_DIR, { recursive: true })
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2))
  return tokens
}
