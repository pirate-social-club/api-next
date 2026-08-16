-- Compatibility migration.
--
-- Post comment lock columns are added by the runtime community DB preflight.
-- Migration 1064 originally added these columns, but it was converted to a
-- ledger-only migration because some community databases already had the
-- columns without a matching schema_migrations entry. Reintroducing ALTER
-- TABLE statements here makes those databases fail with duplicate-column
-- errors during migration replay.
SELECT 1;
