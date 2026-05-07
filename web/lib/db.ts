import postgres from 'postgres'

let _sql: ReturnType<typeof postgres> | null = null

export function getSql(): ReturnType<typeof postgres> {
  if (_sql) return _sql
  const url = process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  _sql = postgres(url, {
    ssl: url.includes('localhost') ? false : 'require',
    max: 10,
    idle_timeout: 20,
  })
  return _sql
}

export default getSql
