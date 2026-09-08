import { createHash } from "node:crypto";
import type { Client } from "pg";

// Owner-dispositioned substrate identity. Application labels and process counts
// are observations, not an exhaustive identity list. Observe verifies the role.
type Session = {
  pid: number;
  usename: string | null;
  application_sha256: string | null;
  user_oid?: string | null;
  backend_type_sha256?: string | null;
};

export function describeRehearsalSessions(
  sessions: readonly Session[],
  ownedPids: readonly number[],
) {
  return sessions.map((session) => ({
    pid: session.pid,
    owned: ownedPids.includes(session.pid),
    role_sha256:
      session.usename === null ? null : createHash("sha256").update(session.usename).digest("hex"),
    application_sha256: session.application_sha256,
    user_oid: session.user_oid ?? null,
    backend_type_sha256: session.backend_type_sha256 ?? null,
  }));
}

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
  const applications: (string | null)[] = [];
  const observedOwned: number[] = [];
  for (const session of sessions) {
    if (session.usename === operator && ownedPids.includes(session.pid)) {
      observedOwned.push(session.pid);
    } else if (session.usename === "pscale_admin") {
      applications.push(session.application_sha256);
    } else throw new Error("rehearsal_unexpected_session");
  }
  if (observedOwned.length !== ownedPids.length) throw new Error("rehearsal_owned_session_missing");
  return {
    provider_sessions: applications.length,
    operator_sessions: observedOwned.length,
    total_sessions: sessions.length,
    application_fingerprints: applications.sort((a, b) => (a ?? "").localeCompare(b ?? "")),
    execution_authorized: false as const,
  };
}

export function assertRehearsalSessionHeadroom(totalSessions: number, clusterBudget: number) {
  if (
    !Number.isSafeInteger(totalSessions) ||
    totalSessions < 1 ||
    !Number.isSafeInteger(clusterBudget) ||
    clusterBudget < 1 ||
    clusterBudget > 1_200 ||
    clusterBudget > 64 * (25 - totalSessions - 2)
  )
    throw new Error("rehearsal_session_headroom_insufficient");
}

export function assertRehearsalProviderRole(value: unknown) {
  if (typeof value !== "object" || value === null)
    throw new Error("rehearsal_provider_role_changed");
  const role = value as Record<string, unknown>;
  if (
    role.rolname !== "pscale_admin" ||
    ["rolsuper", "rolreplication", "rolcreaterole", "rolcreatedb", "rolcanlogin"].some(
      (key) => role[key] !== true,
    )
  )
    throw new Error("rehearsal_provider_role_changed");
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
    await admin.query(`SELECT pid,usesysid::text AS user_oid,usename,application_name,backend_type
      FROM pg_catalog.pg_stat_activity
      WHERE datid=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())`)
  ).rows;
  const mapped = sessions.map((session) => ({
    pid: session.pid,
    usename: session.usename,
    user_oid: session.user_oid,
    backend_type_sha256:
      session.backend_type === null
        ? null
        : createHash("sha256").update(session.backend_type).digest("hex"),
    application_sha256:
      session.application_name === null
        ? null
        : createHash("sha256").update(session.application_name).digest("hex"),
  }));
  const ownedPids = observerPid === undefined ? [identity.pid] : [identity.pid, observerPid];
  let observed: ReturnType<typeof assertRehearsalSessions>;
  try {
    observed = assertRehearsalSessions(mapped, operator, ownedPids);
  } catch (error) {
    // Capture the failing observation itself, not a later scan after a transient
    // session disappears. Never log role names, application strings or queries.
    console.error(
      JSON.stringify({
        mode: "rehearsal-session-refused",
        sessions: describeRehearsalSessions(mapped, ownedPids),
      }),
    );
    throw error;
  }
  const row = (
    await admin.query(`SELECT
      (SELECT count(*)::int FROM pg_catalog.pg_prepared_xacts WHERE database=current_database()) AS prepared,
      (SELECT count(*)::int FROM pg_catalog.pg_locks WHERE NOT fastpath) AS shared_locks,
      current_setting('max_locks_per_transaction')::int AS locks_per_transaction,
      current_setting('max_connections')::int AS max_connections,
      current_setting('max_prepared_transactions')::int AS max_prepared_transactions,
      (SELECT json_build_object('rolname',rolname,'rolsuper',rolsuper,
        'rolreplication',rolreplication,'rolcreaterole',rolcreaterole,
        'rolcreatedb',rolcreatedb,'rolcanlogin',rolcanlogin)
       FROM pg_catalog.pg_roles WHERE rolname='pscale_admin') AS provider_role`)
  ).rows[0];
  assertRehearsalProviderRole(row?.provider_role);
  if (
    row?.prepared !== 0 ||
    row.locks_per_transaction !== 64 ||
    row.max_connections !== 25 ||
    row.max_prepared_transactions !== 0
  )
    throw new Error("rehearsal_capacity_or_prepared_state_changed");
  return { ...observed, shared_locks: row.shared_locks, settings: [64, 25, 0] as const };
}
