import type { Client } from "pg";

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
    await admin.query("SELECT pg_catalog.pg_stat_clear_snapshot()");
    const result = await admin.query(`SELECT
      (SELECT count(*)::int FROM pg_catalog.pg_stat_activity
        WHERE datid = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database())
          AND pid <> pg_catalog.pg_backend_pid()) AS other_sessions,
      (SELECT count(*)::int FROM pg_catalog.pg_prepared_xacts
        WHERE database = current_database()) AS prepared_transactions`);
    const row = result.rows[0];
    if (row?.other_sessions !== 0 || row.prepared_transactions !== 0) {
      throw new Error("not_drained");
    }
    await admin.query("ROLLBACK");
    return Object.freeze({
      scan_version: 1,
      other_sessions: 0,
      prepared_transactions: 0,
      execution_authorized: false,
    });
  } catch {
    await admin.query("ROLLBACK").catch(() => undefined);
    throw new Error("session_drain_unproven");
  }
}
