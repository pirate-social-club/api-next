-- Post-barrier PostgreSQL 17 harness fixture. The test supplies run_id and
-- values separately; this file is not a client implementation or migration.

CREATE TABLE IF NOT EXISTS api_next_pg17_abort_probe (
  run_id TEXT PRIMARY KEY,
  phase TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The interrupted transaction inserts this row before SELECT pg_sleep(10).
-- An independent admin connection must find no row after backend termination.
-- The test's parameterized statement is:
-- INSERT INTO api_next_pg17_abort_probe (run_id, phase) VALUES ($1, $2)
