import { createHash } from "node:crypto";
import type { Client } from "pg";

// Owner-dispositioned provider baseline, compared on main and the isolated
// branch on 2026-09-06. Hidden activity fields are not treated as empty values.
const providerApplications = [
  "4d610df279c4c8ef752e6ce9ba073967a3ea23cc7d09024922ac9da4f17cf930",
  "a2f5ec7abc29f65a8dfc0527aaca0fe6140718ccec2828d243c8ada40c5fe7e3",
];
type Session = { pid: number; usename: string | null; application_sha256: string | null };

/** Pure baseline comparison; it neither proves branch identity nor prevents
 * reconnects. The isolated-branch target and Hyperdrive checks remain separate.
 */
export function assertRehearsalSessions(
  sessions: readonly Session[],
  operator: string,
  ownedPids: readonly number[],
) {
  if (
    !operator ||
    operator === "pscale_admin" ||
    ownedPids.length < 1 ||
    ownedPids.length > 2 ||
    ownedPids.some((pid) => !Number.isSafeInteger(pid) || pid < 1) ||
    new Set(ownedPids).size !== ownedPids.length ||
    new Set(sessions.map((session) => session.pid)).size !== sessions.length
  )
    throw new Error("rehearsal_session_input_unproven");
  const applications: string[] = [];
  const observedOwned: number[] = [];
  for (const session of sessions) {
    if (session.usename === operator && ownedPids.includes(session.pid)) {
      observedOwned.push(session.pid);
    } else if (session.usename === "pscale_admin" && session.application_sha256 !== null) {
      applications.push(session.application_sha256);
    } else throw new Error("rehearsal_unexpected_session");
  }
  if (
    JSON.stringify(applications.sort()) !== JSON.stringify(providerApplications) ||
    observedOwned.length !== ownedPids.length
  )
    throw new Error("rehearsal_session_baseline_changed");
  return {
    provider_sessions: applications.length,
    operator_sessions: observedOwned.length,
    total_sessions: sessions.length,
    application_fingerprints: applications,
    execution_authorized: false as const,
  };
}

/** Uses only visible session columns. Caller may be inside a reset transaction;
 * this helper neither opens nor closes it, and never asks for query visibility.
 */
export async function observeRehearsalSessions(
  admin: Pick<Client, "query">,
  operator: string,
  observerPid?: number,
) {
  const identity = (
    await admin.query("SELECT session_user AS login,current_user AS active,pg_backend_pid() AS pid")
  ).rows[0];
  if (identity?.login !== operator || identity.active !== operator)
    throw new Error("rehearsal_operator_changed");
  await admin.query("SELECT pg_catalog.pg_stat_clear_snapshot()");
  const sessions = (
    await admin.query(`SELECT pid,usename,application_name FROM pg_catalog.pg_stat_activity
      WHERE datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())`)
  ).rows;
  const observed = assertRehearsalSessions(
    sessions.map((session) => ({
      pid: session.pid,
      usename: session.usename,
      application_sha256:
        session.application_name === null
          ? null
          : createHash("sha256").update(session.application_name).digest("hex"),
    })),
    operator,
    observerPid === undefined ? [identity.pid] : [identity.pid, observerPid],
  );
  const row = (
    await admin.query(`SELECT
      (SELECT count(*)::int FROM pg_catalog.pg_prepared_xacts WHERE database=current_database()) AS prepared,
      (SELECT count(*)::int FROM pg_catalog.pg_locks WHERE NOT fastpath) AS shared_locks,
      current_setting('max_locks_per_transaction')::int AS locks_per_transaction,
      current_setting('max_connections')::int AS max_connections,
      current_setting('max_prepared_transactions')::int AS max_prepared_transactions`)
  ).rows[0];
  if (
    row?.prepared !== 0 ||
    row.locks_per_transaction !== 64 ||
    row.max_connections !== 25 ||
    row.max_prepared_transactions !== 0
  )
    throw new Error("rehearsal_capacity_or_prepared_state_changed");
  return { ...observed, shared_locks: row.shared_locks, settings: [64, 25, 0] as const };
}
