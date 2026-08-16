-- Compatibility migration.
--
-- Updating SQLite CHECK constraints for posts.rights_basis and assets.rights_basis
-- requires rebuilding those tables. The posts table also has columns that are
-- added by runtime preflight, so the rebuild runs there where the current table
-- shape can be inspected and preserved safely.
SELECT 1;
