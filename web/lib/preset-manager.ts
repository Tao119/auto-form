import fs from 'fs'
import path from 'path'
import type { Preset, SearchTarget } from './types'

const DATA_DIR = path.join(process.cwd(), 'data')
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json')

function ensureFile(): void {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(PRESETS_FILE)) fs.writeFileSync(PRESETS_FILE, '[]')
}

export function getPresets(): Preset[] {
  ensureFile()
  return JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf-8')) as Preset[]
}

export function savePreset(name: string, searchTarget: SearchTarget): Preset {
  const presets = getPresets()
  const maxId = presets.reduce((m, p) => {
    const n = parseInt(p.id.replace('preset-', ''), 10)
    return isNaN(n) ? m : Math.max(m, n)
  }, 0)
  const preset: Preset = {
    id: `preset-${String(maxId + 1).padStart(3, '0')}`,
    name,
    createdAt: new Date().toISOString(),
    searchTarget,
  }
  presets.push(preset)
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2))
  return preset
}

export function deletePreset(id: string): void {
  const presets = getPresets().filter((p) => p.id !== id)
  fs.writeFileSync(PRESETS_FILE, JSON.stringify(presets, null, 2))
}

export function getPreset(id: string): Preset | undefined {
  return getPresets().find((p) => p.id === id)
}
