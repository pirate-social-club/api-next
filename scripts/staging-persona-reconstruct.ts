import { ControlPlaneStatementFailed, type ControlPlaneTransaction } from "@pirate/application";
import { Effect, Predicate } from "effect";
import type { Client } from "pg";
import { applyPostgresMigrationsInTransaction } from "../packages/platform-cf/src/postgres-migrations";
import { readResetGrantCatalog, restoreReviewedResetGrants } from "./staging-persona-grant-catalog";
import { type ResetGrant, reconcileResetGrants } from "./staging-persona-grant-reconciliation";
import { snapshotOutsideResetCatalog } from "./staging-persona-outside-catalog";
import { removeStagingObjectsInTransaction } from "./staging-persona-remove-objects";
import { prepareStagingReplayContext } from "./staging-persona-replay-context";
import {
  assertStagingResetLedger,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";
import { readResetSchemaShape } from "./staging-persona-schema-shape";

/** No new connection or transaction: migration SQL uses exactly the removal client. */
export function migrationTransaction(admin: Pick<Client, "query">): ControlPlaneTransaction {
  return {
    execute: (statement) =>
      Effect.tryPromise({
        try: async () => {
          const result = await admin.query(statement.text, [...statement.values]);
          // Migration files contain several statements; only ledger queries need rows.
          return { rows: result.rows ?? [], rowCount: result.rowCount ?? 0 };
        },
        catch: (error) =>
          new ControlPlaneStatementFailed({
            label: statement.label,
            sqlState:
              Predicate.isObject(error) &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[A-Z0-9]{5}$/u.test(error.code)
                ? error.code
                : null,
            constraint: null,
            outcomeCertainty: "unknown",
          }),
      }),
  };
}

/**
 * Internal transaction body, NOT an admitted live command. Caller must supply
 * freshly verified provider/SQL identity, independently approved grant/default
 * policy and measured baseline, and maintain the external producer fence and
 * recovery gate. Caller must ROLLBACK on any failure. This function never COMMITs.
 */
export async function reconstructStagingInTransaction(
  admin: Pick<Client, "query">,
  artifacts: Parameters<typeof validateStagingResetArtifacts>[0],
  expected: Readonly<{
    database: string;
    sessionRole: string;
    schemaOid: number;
    defaultsSha256: string;
    baselineShapeSha256: string;
    reviewedGrants: readonly ResetGrant[];
    replayStatementTimeoutMs: number;
    minimumLockTableEntries: number;
  }>,
) {
  const plan = validateStagingResetArtifacts(artifacts);
  reconcileResetGrants({ before: [], replay: [], reviewed: expected.reviewedGrants });
  if (
    !/^[a-f0-9]{64}$/u.test(expected.defaultsSha256) ||
    !/^[a-f0-9]{64}$/u.test(expected.baselineShapeSha256)
  )
    throw new Error("reset_reference_invalid");
  if (
    !Number.isSafeInteger(expected.minimumLockTableEntries) ||
    expected.minimumLockTableEntries < 1
  ) {
    throw new Error("reset_lock_capacity_reference_invalid");
  }
  const identity = await admin.query(`SELECT current_database() AS database,
    session_user AS session_role,current_user AS active_role,
    pg_catalog.pg_current_xact_id()::text AS transaction_id,
    (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='api_next') AS schema_oid`);
  const row = identity.rows[0];
  if (
    row?.database !== expected.database ||
    row.session_role !== expected.sessionRole ||
    row.active_role !== expected.sessionRole ||
    row.schema_oid !== expected.schemaOid
  ) {
    throw new Error("reset_target_identity_mismatch");
  }
  // Also refuses autocommit before any destructive statement, even if the caller
  // accidentally invoked the body without BEGIN.
  await prepareStagingReplayContext(admin, {
    transactionId: row.transaction_id,
    schemaOid: expected.schemaOid,
    statementTimeoutMs: expected.replayStatementTimeoutMs,
  });
  await admin.query("SET LOCAL search_path = pg_catalog");
  const capacity = await admin.query(`SELECT current_setting('max_locks_per_transaction')::bigint *
    (current_setting('max_connections')::bigint + current_setting('max_prepared_transactions')::bigint) AS entries`);
  // A successful isolated rehearsal supplies this lower bound. Capacity alone
  // is not a fence or a guarantee of available entries; SQL errors still roll back.
  const lockEntries = Number(capacity.rows[0]?.entries);
  if (!Number.isSafeInteger(lockEntries) || lockEntries < expected.minimumLockTableEntries) {
    throw new Error("reset_lock_capacity_below_rehearsal");
  }
  const schemaBefore = (
    await admin.query(`SELECT oid,nspowner,nspacl FROM pg_catalog.pg_namespace
    WHERE nspname='api_next'`)
  ).rows;
  const ledgerBefore = await admin.query(
    "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
  );
  assertStagingResetLedger(plan, ledgerBefore.rows);
  const grantsBefore = await readResetGrantCatalog(admin);
  if (grantsBefore.defaults_sha256 !== expected.defaultsSha256)
    throw new Error("reset_default_acl_unreviewed");
  const outsideBefore = await snapshotOutsideResetCatalog(admin);
  const removal = await removeStagingObjectsInTransaction(admin, artifacts);
  if (removal.transaction_id !== row.transaction_id) throw new Error("reset_transaction_changed");
  // Prove constrained CASCADE stayed in scope before replay can mask its effects.
  if ((await snapshotOutsideResetCatalog(admin)).sha256 !== outsideBefore.sha256) {
    throw new Error("reset_outside_catalog_changed");
  }
  await prepareStagingReplayContext(admin, {
    transactionId: removal.transaction_id,
    schemaOid: expected.schemaOid,
    statementTimeoutMs: expected.replayStatementTimeoutMs,
  });
  await Effect.runPromise(
    applyPostgresMigrationsInTransaction(migrationTransaction(admin), plan.migrations),
  );
  await admin.query("SET LOCAL search_path = pg_catalog");
  if ((await readResetSchemaShape(admin)).sha256 !== expected.baselineShapeSha256) {
    throw new Error("reset_baseline_shape_mismatch");
  }
  const restored = await restoreReviewedResetGrants(
    admin,
    grantsBefore.grants,
    expected.reviewedGrants,
  );
  if ((await readResetGrantCatalog(admin)).defaults_sha256 !== expected.defaultsSha256) {
    throw new Error("reset_default_acl_changed");
  }
  if ((await snapshotOutsideResetCatalog(admin)).sha256 !== outsideBefore.sha256) {
    throw new Error("reset_outside_catalog_changed");
  }
  const schemaAfter = (
    await admin.query(`SELECT oid,nspowner,nspacl FROM pg_catalog.pg_namespace
    WHERE nspname='api_next'`)
  ).rows;
  if (JSON.stringify(schemaAfter) !== JSON.stringify(schemaBefore))
    throw new Error("reset_schema_identity_changed");
  const ledger = await admin.query(
    "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
  );
  if (
    JSON.stringify(ledger.rows) !==
    JSON.stringify(plan.migrations.map(({ version, checksum }) => ({ version, checksum })))
  ) {
    throw new Error("reset_ledger_verification_failed");
  }
  const counts = await admin.query(`SELECT
    (SELECT count(*) FROM api_next.users)::int AS users,
    (SELECT count(*) FROM api_next.personas)::int AS personas,
    (SELECT count(*) FROM api_next.persona_community_bindings)::int AS bindings,
    (SELECT count(*) FROM api_next.communities)::int AS communities,
    (SELECT count(*) FROM api_next.community_memberships)::int AS memberships`);
  if (
    Object.values(counts.rows[0] ?? {}).length !== 5 ||
    Object.values(counts.rows[0]).some((count) => count !== 0)
  ) {
    throw new Error("reset_identity_state_not_empty");
  }
  await prepareStagingReplayContext(admin, {
    transactionId: removal.transaction_id,
    schemaOid: expected.schemaOid,
    statementTimeoutMs: expected.replayStatementTimeoutMs,
  });
  const evidence = await admin.query(
    "SELECT api_next.persona_community_binding_evidence_digest_v1() AS digest",
  );
  if (
    evidence.rows[0]?.digest !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  ) {
    throw new Error("reset_persona_evidence_not_empty");
  }
  return Object.freeze({
    committed: false,
    execution_authorized: false,
    transaction_id: removal.transaction_id,
    ledger_count: ledger.rows.length,
    terminal_version: plan.migrations.at(-1)?.version,
    outside_catalog_sha256: outsideBefore.sha256,
    evidence_sha256: evidence.rows[0].digest,
    identity_counts: counts.rows[0],
    grants: restored,
  });
}
