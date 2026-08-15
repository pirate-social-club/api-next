-- Compatibility migration.
--
-- These columns are now added by the remote community DB preflight in the API
-- because SQLite/libSQL does not support ALTER TABLE ADD COLUMN IF NOT EXISTS.
-- Several production communities already have the columns but lack this ledger
-- entry, so keeping ALTER TABLE statements here makes fleet migration replay
-- fail with duplicate-column errors.
SELECT 1;
