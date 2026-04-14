import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import logger from '../utils/logger.js'
import { getExistingUrls, appendCompany } from '../sheets/sheets-client.js'
import { classifyForm } from '../ai/form-classifier.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CONFIG_PATH = path.resolve(__dirname, '../../config/search-params.json')
const PUBLIC_DIR = path.resolve(__dirname, 'public')

const app = express()
app.use(express.json())
app.use(express.static(PUBLIC_DIR))

// ===== Config API =====

app.get('/api/config', (req, res) => {
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
  res.json(config)
})

app.put('/api/config', (req, res) => {
  try {
    const config = req.body
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// 単一runの追加
app.post('/api/runs', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    const newRun = req.body
    const maxId = config.runs.reduce((m, r) => {
      const n = parseInt(r.id.replace('run-', ''), 10)
      return isNaN(n) ? m : Math.max(m, n)
    }, 0)
    newRun.id = `run-${String(maxId + 1).padStart(3, '0')}`
    config.runs.push(newRun)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true, run: newRun })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// runの削除
app.delete('/api/runs/:id', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    config.runs = config.runs.filter(r => r.id !== req.params.id)
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// runのtoggle enable/disable
app.patch('/api/runs/:id/toggle', (req, res) => {
  try {
    const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    const run = config.runs.find(r => r.id === req.params.id)
    if (!run) return res.status(404).json({ error: 'Not found' })
    run.enabled = !run.enabled
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2))
    res.json({ ok: true, enabled: run.enabled })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ===== 収集実行 API =====

let collectProcess = null
let collectLog = []

app.post('/api/collect/start', (req, res) => {
  if (collectProcess) {
    return res.status(409).json({ error: '収集中です。完了まで待ってください。' })
  }

  collectLog = []
  const projectRoot = path.resolve(__dirname, '../..')
  collectProcess = spawn('node', ['src/index.js'], {
    cwd: projectRoot,
    env: { ...process.env }
  })

  collectProcess.stdout.on('data', (d) => {
    const line = d.toString().replace(/\x1b\[\d+m/g, '').trim()
    if (line) collectLog.push({ t: Date.now(), msg: line })
  })
  collectProcess.stderr.on('data', (d) => {
    const line = d.toString().replace(/\x1b\[\d+m/g, '').trim()
    if (line) collectLog.push({ t: Date.now(), msg: '[ERR] ' + line })
  })
  collectProcess.on('close', (code) => {
    collectLog.push({ t: Date.now(), msg: `=== 終了 (code: ${code}) ===` })
    collectProcess = null
  })

  res.json({ ok: true })
})

app.get('/api/collect/status', (req, res) => {
  res.json({
    running: !!collectProcess,
    log: collectLog.slice(-100)
  })
})

app.post('/api/collect/stop', (req, res) => {
  if (collectProcess) {
    collectProcess.kill('SIGTERM')
    collectProcess = null
  }
  res.json({ ok: true })
})

// ===== n8n Bridge API（Credentials不要でn8nから呼び出す） =====

// 既存スプシデータ取得（HP URL + フォームURL）
app.get('/api/sheets/existing', async (req, res) => {
  try {
    const spreadsheetId = req.query.spreadsheetId || process.env.GOOGLE_SHEETS_ID
    const { google } = await import('googleapis')
    const { default: sheetsAuth } = await import('../sheets/sheets-auth.js')
    const auth = await sheetsAuth()
    const sheets = google.sheets({ version: 'v4', auth })
    const sheetName = process.env.GOOGLE_SHEETS_SHEET_NAME || '企業リスト'
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${sheetName}!B2:C`
    })
    const rows = (response.data.values || []).map(r => ({
      'HP URL': r[0] || '',
      'フォームURL': r[1] || ''
    }))
    res.json({ rows })
  } catch (e) {
    logger.error('sheets/existing error', { error: e.message })
    res.status(500).json({ error: e.message, rows: [] })
  }
})

// フォーム種別判定（OpenAI）
app.post('/api/classify', async (req, res) => {
  try {
    const { url, html, title, linkText } = req.body
    const result = await classifyForm({ url, html, title, linkText: linkText || '' })
    res.json(result)
  } catch (e) {
    logger.error('classify error', { error: e.message })
    res.status(500).json({ error: e.message, type: 'inquiry' })
  }
})

// スプシ書き込み
app.post('/api/sheets/append', async (req, res) => {
  try {
    const company = req.body
    const result = await appendCompany(company)
    res.json(result)
  } catch (e) {
    logger.error('sheets/append error', { error: e.message })
    res.status(500).json({ error: e.message })
  }
})

// ===== Start =====

const PORT = process.env.WEB_PORT || 3080
app.listen(PORT, () => {
  logger.info(`管理画面: http://localhost:${PORT}`)
})
