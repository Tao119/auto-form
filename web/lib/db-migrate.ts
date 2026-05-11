export async function runMigrations(): Promise<void> {
  // Tables already created in Supabase dashboard
  // serper_jobs table SQL (run in Supabase SQL Editor):
  //
  // CREATE TABLE IF NOT EXISTS serper_jobs (
  //   id           TEXT PRIMARY KEY,
  //   status       TEXT NOT NULL DEFAULT 'queued',
  //   params       JSONB NOT NULL DEFAULT '{}',
  //   result_count INTEGER,
  //   result_items JSONB,
  //   error        TEXT,
  //   created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  //   started_at   TIMESTAMPTZ,
  //   completed_at TIMESTAMPTZ
  // );
  // CREATE INDEX IF NOT EXISTS serper_jobs_status_idx ON serper_jobs(status);
  // CREATE INDEX IF NOT EXISTS serper_jobs_created_idx ON serper_jobs(created_at DESC);
}
