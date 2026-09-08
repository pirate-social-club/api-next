import type { Client } from "pg";

/** Internal handoff only. This does not replay, commit, or authorize a reset. */
export async function prepareStagingReplayContext(
  admin: Pick<Client, "query">,
  expected: Readonly<{
    transactionId: string;
    schemaOid: number;
    statementTimeoutMs: number;
  }>,
) {
  if (
    !/^\d+$/u.test(expected.transactionId) ||
    !Number.isSafeInteger(expected.schemaOid) ||
    expected.schemaOid <= 0 ||
    !Number.isSafeInteger(expected.statementTimeoutMs) ||
    expected.statementTimeoutMs < 1 ||
    expected.statementTimeoutMs > 600_000
  ) {
    throw new Error("reset_replay_context_invalid");
  }
  const assertIdentity = async () => {
    const result = await admin.query(`SELECT
      pg_catalog.pg_current_xact_id()::text AS transaction_id,
      (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='api_next') AS schema_oid,
      pg_catalog.current_setting('transaction_isolation') AS isolation`);
    const row = result.rows[0];
    if (
      row?.transaction_id !== expected.transactionId ||
      row.schema_oid !== expected.schemaOid ||
      row.isolation !== "read committed"
    ) {
      throw new Error("reset_replay_identity_changed");
    }
  };
  await assertIdentity();
  // Removal intentionally leaves pg_catalog first. Never inherit that setting
  // or its 15-second timeout for unqualified migration SQL.
  await admin.query("SET LOCAL search_path = api_next, pg_catalog");
  await admin.query("SELECT pg_catalog.set_config('statement_timeout', $1, true)", [
    `${expected.statementTimeoutMs}ms`,
  ]);
  const path = await admin.query(`SELECT
    pg_catalog.current_schema() AS target,
    pg_catalog.current_schemas(true)::text[] AS schemas`);
  if (
    path.rows[0]?.target !== "api_next" ||
    JSON.stringify(path.rows[0]?.schemas) !== JSON.stringify(["api_next", "pg_catalog"])
  ) {
    // Includes an implicit temporary schema, a missing target, or path drift.
    throw new Error("reset_replay_search_path_invalid");
  }
  await assertIdentity();
}
