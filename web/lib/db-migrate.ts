import getSql from './db'

export async function runMigrations(): Promise<void> {
  const sql = getSql()

  await sql`
    CREATE TABLE IF NOT EXISTS companies (
      id                TEXT PRIMARY KEY,
      name              TEXT NOT NULL DEFAULT '',
      hp_url            TEXT NOT NULL DEFAULT '',
      form_url          TEXT NOT NULL DEFAULT '',
      normalized_form_url TEXT NOT NULL DEFAULT '',
      normalized_hp_url TEXT NOT NULL DEFAULT '',
      phone             TEXT NOT NULL DEFAULT '',
      email             TEXT NOT NULL DEFAULT '',
      address           TEXT NOT NULL DEFAULT '',
      industry          TEXT NOT NULL DEFAULT '',
      area              TEXT NOT NULL DEFAULT '',
      form_type         TEXT NOT NULL DEFAULT '',
      status            TEXT NOT NULL DEFAULT '未送信',
      notes             TEXT NOT NULL DEFAULT '',
      project_id        TEXT NOT NULL DEFAULT '',
      run_id            TEXT NOT NULL DEFAULT '',
      collected_at      TEXT NOT NULL DEFAULT '',
      imported_from_sheets BOOLEAN NOT NULL DEFAULT FALSE
    )
  `

  await sql`CREATE INDEX IF NOT EXISTS idx_companies_normalized_form_url ON companies(normalized_form_url)`
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_normalized_hp_url   ON companies(normalized_hp_url)`
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_project_id          ON companies(project_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_run_id              ON companies(run_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_industry            ON companies(industry)`
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_area                ON companies(area)`
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_status              ON companies(status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_form_type           ON companies(form_type)`
  await sql`CREATE INDEX IF NOT EXISTS idx_companies_collected_at        ON companies(collected_at DESC)`

  await sql`
    CREATE TABLE IF NOT EXISTS projects (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  TEXT NOT NULL,
      run_ids     JSONB NOT NULL DEFAULT '[]',
      sheets_id   TEXT
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS project_runs (
      id              TEXT PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      label           TEXT NOT NULL,
      created_at      TEXT NOT NULL,
      search_target   JSONB NOT NULL DEFAULT '{}',
      status          TEXT NOT NULL DEFAULT 'pending',
      run_type        TEXT,
      parent_run_id   TEXT,
      child_run_ids   JSONB,
      n8n_execution_id TEXT,
      items_written   INTEGER,
      completed_at    TEXT,
      estimated_cost_usd NUMERIC,
      tokens_input    INTEGER,
      tokens_output   INTEGER,
      raw_search_count INTEGER,
      results         JSONB,
      error           TEXT
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_project_runs_project_id    ON project_runs(project_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_project_runs_parent_run_id ON project_runs(parent_run_id)`

  await sql`
    CREATE TABLE IF NOT EXISTS queue_jobs (
      id          TEXT PRIMARY KEY,
      run_id      TEXT NOT NULL,
      project_id  TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'waiting',
      params      JSONB NOT NULL DEFAULT '{}',
      created_at  TEXT NOT NULL,
      started_at  TEXT,
      completed_at TEXT,
      error       TEXT
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_queue_jobs_status ON queue_jobs(status)`

  await sql`
    CREATE TABLE IF NOT EXISTS presets (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      created_at    TEXT NOT NULL,
      search_target JSONB NOT NULL DEFAULT '{}'
    )
  `
}
