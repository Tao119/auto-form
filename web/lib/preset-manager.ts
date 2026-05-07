import getSql from './db'
import type { Preset, SearchTarget } from './types'

function rowToPreset(r: Record<string, unknown>): Preset {
  return {
    id:           r.id as string,
    name:         r.name as string,
    createdAt:    r.created_at as string,
    searchTarget: r.search_target as SearchTarget,
  }
}

export async function getPresets(): Promise<Preset[]> {
  const sql = getSql()
  const rows = await sql`SELECT * FROM presets ORDER BY created_at DESC`
  return rows.map(rowToPreset)
}

export async function savePreset(name: string, searchTarget: SearchTarget): Promise<Preset> {
  const sql = getSql()
  const rows = await sql`SELECT id FROM presets ORDER BY created_at DESC LIMIT 1`
  const maxId = rows.length > 0
    ? parseInt((rows[0].id as string).replace('preset-', ''), 10) || 0
    : 0
  const id = `preset-${String(maxId + 1).padStart(3, '0')}`
  const createdAt = new Date().toISOString()
  await sql`INSERT INTO presets (id, name, created_at, search_target) VALUES (${id}, ${name}, ${createdAt}, ${sql.json(searchTarget as unknown as Parameters<typeof sql.json>[0])})`
  return { id, name, createdAt, searchTarget }
}

export async function deletePreset(id: string): Promise<void> {
  const sql = getSql()
  await sql`DELETE FROM presets WHERE id = ${id}`
}

export async function getPreset(id: string): Promise<Preset | undefined> {
  const sql = getSql()
  const rows = await sql`SELECT * FROM presets WHERE id = ${id}`
  return rows.length > 0 ? rowToPreset(rows[0]) : undefined
}
