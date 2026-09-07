import type { Client } from "pg";

/** Observe within an executor-owned transaction without beginning, ending, or
 * changing it. Only this connection is excluded; no supplied PID exemption is
 * accepted. The transaction identity must come from the admitted executor. */
export async function observeSessionDrainInTransaction(
  admin: Client,
  expectedAdmin: string,
  expectedTransactionId: string,
) {
  if (!expectedAdmin || !/^\d+$/.test(expectedTransactionId))
    throw new Error("session_drain_input");
  try {
    const identity = await admin.query(`SELECT
      session_user::text AS login, current_user::text AS effective,
      pg_catalog.pg_current_xact_id_if_assigned()::text AS transaction_id,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)
        OR pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS full_visibility`);
    const role = identity.rows[0];
    if (
      role?.login !== expectedAdmin ||
      role.effective !== expectedAdmin ||
      role.transaction_id !== expectedTransactionId ||
      role.full_visibility !== true
    )
      throw new Error("visibility_or_transaction");
    return await readSessionDrain(admin);
  } catch {
    throw new Error("session_drain_unproven");
  }
}

async function readSessionDrain(admin: Client) {
  await admin.query("SELECT pg_catalog.pg_stat_clear_snapshot()");
  const result = await admin.query(`SELECT
    (SELECT count(*)::int FROM pg_catalog.pg_stat_activity
      WHERE datid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
        AND pid <> pg_catalog.pg_backend_pid()) AS other_sessions,
    (SELECT count(*)::int FROM pg_catalog.pg_prepared_xacts
      WHERE database = current_database()) AS prepared_transactions`);
  const row = result.rows[0];
  if (row?.other_sessions !== 0 || row.prepared_transactions !== 0) throw new Error("not_drained");
  return Object.freeze({
    scan_version: 1,
    other_sessions: 0,
    prepared_transactions: 0,
    execution_authorized: false,
  });
}

/**
 * Read-only observation on a fresh, idle dedicated administrative connection.
 * Never pass a connection with an existing transaction: cleanup rolls it back.
 * Runtime probes must already be closed. This never terminates a session,
 * resolves a prepared transaction, fences a producer, or authorizes execution.
 */
export async function observeSessionDrain(admin: Client, expectedAdmin: string) {
  if (!expectedAdmin) throw new Error("session_drain_input");
  try {
    await admin.query("BEGIN READ ONLY");
    await admin.query("SET LOCAL statement_timeout = '5s'");
    await admin.query("SET LOCAL search_path = pg_catalog");
    await admin.query("SET LOCAL max_parallel_workers_per_gather = 0");
    const identity = await admin.query(`SELECT
      session_user::text AS login, current_user::text AS effective,
      (SELECT rolsuper FROM pg_catalog.pg_roles WHERE rolname = current_user)
        OR pg_catalog.pg_has_role(current_user, 'pg_read_all_stats', 'USAGE') AS full_visibility`);
    const role = identity.rows[0];
    if (
      role?.login !== expectedAdmin ||
      role.effective !== expectedAdmin ||
      role.full_visibility !== true
    ) {
      throw new Error("visibility");
    }
    const observation = await readSessionDrain(admin);
    await admin.query("ROLLBACK");
    return observation;
  } catch {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw new Error("session_drain_unproven");
  }
}
