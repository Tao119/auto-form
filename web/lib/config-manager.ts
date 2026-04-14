import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import type { SearchConfig, SearchRun } from './types'

const CONFIG_DIR = process.env.CONFIG_DIR || path.resolve(process.cwd(), '../config')

function getConfigPath() {
  return path.join(CONFIG_DIR, 'search-params.json')
}

export function getConfig(): SearchConfig {
  const raw = fs.readFileSync(getConfigPath(), 'utf-8')
  return JSON.parse(raw) as SearchConfig
}

const SearchTargetSchema = z.object({
  industry: z.string().min(1),
  area: z.string().min(1),
  keywords: z.array(z.string()),
  maxResults: z.number().int().min(1).max(200),
})

const SearchRunSchema = z.object({
  id: z.string(),
  enabled: z.boolean(),
  label: z.string(),
  searchTargets: z.array(SearchTargetSchema),
})

const ConfigSchema = z.object({
  _comment: z.string().optional(),
  runs: z.array(SearchRunSchema),
  areaExpansion: z.record(z.array(z.string())),
  formDetection: z.any().optional(),
  sheetsColumns: z.any().optional(),
})

export function updateConfig(config: SearchConfig): void {
  ConfigSchema.parse(config)
  const tmp = getConfigPath() + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2))
  fs.renameSync(tmp, getConfigPath())
}

export function addRun(run: Omit<SearchRun, 'id'>): SearchRun {
  const config = getConfig()
  const maxId = config.runs.reduce((m, r) => {
    const n = parseInt(r.id.replace('run-', ''), 10)
    return isNaN(n) ? m : Math.max(m, n)
  }, 0)
  const newRun: SearchRun = { ...run, id: `run-${String(maxId + 1).padStart(3, '0')}` }
  config.runs.push(newRun)
  updateConfig(config)
  return newRun
}

export function removeRun(id: string): void {
  const config = getConfig()
  config.runs = config.runs.filter((r) => r.id !== id)
  updateConfig(config)
}

export function toggleRun(id: string): boolean {
  const config = getConfig()
  const run = config.runs.find((r) => r.id === id)
  if (!run) throw new Error(`Run ${id} not found`)
  run.enabled = !run.enabled
  updateConfig(config)
  return run.enabled
}
