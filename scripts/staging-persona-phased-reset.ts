import type { Client } from "pg";
import { readResetGrantCatalog, restoreReviewedResetGrants } from "./staging-persona-grant-catalog";
import { type ResetGrant, reconcileResetGrants } from "./staging-persona-grant-reconciliation";
import { snapshotOutsideResetCatalog } from "./staging-persona-outside-catalog";
import { type RemovalBatchBudget, removeStagingRootBatch } from "./staging-persona-phased-removal";
import { replayStagingMigrationBatch } from "./staging-persona-phased-replay";
import { inspectStagingRemovalPlan } from "./staging-persona-removal-plan";
import { createResetMarker } from "./staging-persona-reset-marker";
import {
  assertStagingResetLedger,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan";
import { readResetSchemaShape } from "./staging-persona-schema-shape";

/** Trusted in-process admission, NOT JSON flags. Provider/fence/recovery
 * collectors are still separate required work. No standalone live CLI exists.
 */
type PhasedAdmission = Readonly<{
  assertFenceAndRecovery(): Promise<void>;
  assertBaselineReference(sourceSha: string, digest: string): Promise<void>;
  assertFreshFence(): Promise<void>;
  markerDirectory: string;
  recoveryDigest: string;
  targetAndFenceDigest: string;
  validUntilMs: number;
  database: string;
  role: string;
  schemaOid: number;
  defaultsDigest: string;
  baselineDigest: string;
  reviewedGrants: readonly ResetGrant[];
  removalBudget: RemovalBatchBudget;
  replayBudget: { maxLockRows: number; maxClusterLockRows: number; statementTimeoutMs: number };
  // Test/rehearsal observation or failure injection; never a resumption hook.
  afterBatch?(phase: "removing" | "replaying", count: number): Promise<void>;
}>;

/** Committed phases cannot roll back as a group. Every error retains the marker
 * and requires capture restore. Caller keeps the fence through paired deployment
 * and independent post-deploy verification; only then may it clear the marker.
 */
export async function reconstructStagingInPhases(
  admin: Client,
  artifacts: Parameters<typeof validateStagingResetArtifacts>[0],
  admission: PhasedAdmission,
) {
  const plan = validateStagingResetArtifacts(artifacts);
  if (
    !/^[a-f0-9]{64}$/.test(admission.baselineDigest) ||
    !/^[a-f0-9]{64}$/.test(admission.defaultsDigest)
  )
    throw new Error("reset_reference_digest_invalid");
  if (
    [...Object.values(admission.removalBudget), ...Object.values(admission.replayBudget)].some(
      (n) => !Number.isSafeInteger(n) || n < 1,
    )
  )
    throw new Error("reset_phase_budget_invalid");
  if (admission.removalBudget.maxClusterLockRows !== admission.replayBudget.maxClusterLockRows)
    throw new Error("reset_common_cluster_budget_required");
  // This orchestrator owns COMMIT. Refuse a caller-owned transaction rather
  // than accepting PostgreSQL's nested-BEGIN warning and committing its work.
  const first = (await admin.query("SELECT pg_catalog.pg_current_xact_id()::text AS id")).rows[0]
    .id;
  const second = (await admin.query("SELECT pg_catalog.pg_current_xact_id()::text AS id")).rows[0]
    .id;
  if (first === second) throw new Error("reset_fresh_idle_connection_required");
  await admission.assertFenceAndRecovery();
  await admission.assertBaselineReference(plan.sourceSha, admission.baselineDigest);
  const replicated = (
    await admin.query(`SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication_rel p JOIN pg_catalog.pg_class c ON c.oid=p.prrelid
    WHERE c.relnamespace='api_next'::regnamespace
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_subscription_rel s JOIN pg_catalog.pg_class c ON c.oid=s.srrelid
    WHERE c.relnamespace='api_next'::regnamespace
    UNION ALL
    SELECT 1 FROM pg_catalog.pg_publication_namespace WHERE pnnspid='api_next'::regnamespace
    UNION ALL SELECT 1 FROM pg_catalog.pg_publication WHERE puballtables
  ) AS present`)
  ).rows[0].present;
  if (replicated) throw new Error("reset_replication_membership_requires_disposition");
  const marker = await createResetMarker(admission.markerDirectory, {
    sourceSha: plan.sourceSha,
    recoveryDigest: admission.recoveryDigest,
    targetAndFenceDigest: admission.targetAndFenceDigest,
    validUntilMs: admission.validUntilMs,
  });
  let batches = 0;
  let maxOwnLocks = 0;
  let maxClusterLocks = 0;
  let maxClosureObjects = 0;
  const transaction = async <T>(body: (transactionId: string) => Promise<T>): Promise<T> => {
    if (Date.now() >= admission.validUntilMs)
      throw new Error("reset_admission_expired_restore_required");
    await admission.assertFreshFence();
    await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await admin.query("SET LOCAL search_path=pg_catalog");
      await admin.query("SET LOCAL lock_timeout='2s'");
      await admin.query("SELECT set_config('statement_timeout',$1,true)", [
        `${admission.replayBudget.statementTimeoutMs}ms`,
      ]);
      const row = (
        await admin.query(`SELECT current_database() AS database,session_user AS login,
        current_user AS active,'api_next'::regnamespace::oid AS oid,pg_current_xact_id()::text AS xid`)
      ).rows[0];
      if (
        row.database !== admission.database ||
        row.login !== admission.role ||
        row.active !== admission.role ||
        row.oid !== admission.schemaOid
      )
        throw new Error("reset_target_changed_restore_required");
      const result = await body(row.xid);
      const locks = (
        await admin.query(`SELECT count(*) FILTER (WHERE pid=pg_backend_pid())::int AS own,
        count(*)::int AS cluster FROM pg_catalog.pg_locks WHERE NOT fastpath`)
      ).rows[0];
      maxOwnLocks = Math.max(maxOwnLocks, locks.own);
      maxClusterLocks = Math.max(maxClusterLocks, locks.cluster);
      if (
        locks.own >
          Math.max(admission.removalBudget.maxOwnLockRows, admission.replayBudget.maxLockRows) ||
        locks.cluster > admission.removalBudget.maxClusterLockRows
      )
        throw new Error("reset_final_batch_lock_budget_exceeded_restore_required");
      await admission.assertFreshFence();
      if (Date.now() >= admission.validUntilMs)
        throw new Error("reset_admission_expired_restore_required");
      await admin.query("COMMIT");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  };
  try {
    const original = await transaction(async () => {
      assertStagingResetLedger(
        plan,
        (
          await admin.query(
            "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
          )
        ).rows,
      );
      const grants = await readResetGrantCatalog(admin);
      if (grants.defaults_sha256 !== admission.defaultsDigest)
        throw new Error("reset_default_acl_unreviewed");
      await inspectStagingRemovalPlan(admin, artifacts);
      const schema = (
        await admin.query("SELECT oid,nspowner,nspacl FROM pg_namespace WHERE nspname='api_next'")
      ).rows;
      return { grants, schema, outside: (await snapshotOutsideResetCatalog(admin)).sha256 };
    });
    const verifyOutside = async () => {
      if ((await snapshotOutsideResetCatalog(admin)).sha256 !== original.outside)
        throw new Error("reset_outside_catalog_changed_restore_required");
    };
    await marker.advance("removing", batches);
    for (;;) {
      const result = await transaction(async (transactionId) => {
        const result = await removeStagingRootBatch(admin, artifacts, {
          transactionId,
          schemaOid: admission.schemaOid,
          budget: admission.removalBudget,
        });
        return result;
      });
      if (result.empty) break;
      maxClosureObjects = Math.max(maxClosureObjects, result.closureObjects);
      await marker.advance("removing", ++batches);
      await admission.afterBatch?.("removing", batches);
    }
    // The fence/marker holds while batches commit. Detect any out-of-scope
    // change before replay could hide it; every failure requires full restore.
    await transaction(verifyOutside);
    const verifyFinal = async (restoreGrants = false) => {
      await admin.query("SET LOCAL search_path=pg_catalog");
      const schema = (
        await admin.query("SELECT oid,nspowner,nspacl FROM pg_namespace WHERE nspname='api_next'")
      ).rows;
      if (JSON.stringify(schema) !== JSON.stringify(original.schema))
        throw new Error("reset_schema_identity_changed");
      if ((await readResetSchemaShape(admin)).sha256 !== admission.baselineDigest)
        throw new Error("reset_baseline_shape_mismatch");
      if (restoreGrants)
        await restoreReviewedResetGrants(admin, original.grants.grants, admission.reviewedGrants);
      else if (
        reconcileResetGrants({
          before: [],
          replay: (await readResetGrantCatalog(admin)).grants,
          reviewed: admission.reviewedGrants,
        }).unfulfilledReviewed.length
      )
        throw new Error("reset_final_grants_changed");
      if ((await readResetGrantCatalog(admin)).defaults_sha256 !== admission.defaultsDigest)
        throw new Error("reset_defaults_changed");
      await verifyOutside();
      const ledger = (
        await admin.query(
          "SELECT version,checksum FROM api_next.schema_migrations ORDER BY version",
        )
      ).rows;
      if (
        JSON.stringify(ledger) !==
        JSON.stringify(plan.migrations.map(({ version, checksum }) => ({ version, checksum })))
      )
        throw new Error("reset_final_ledger_changed");
      const counts = (
        await admin.query(`SELECT
        (SELECT count(*) FROM api_next.users)::int AS users,
        (SELECT count(*) FROM api_next.personas)::int AS personas,
        (SELECT count(*) FROM api_next.persona_community_bindings)::int AS bindings,
        (SELECT count(*) FROM api_next.communities)::int AS communities,
        (SELECT count(*) FROM api_next.community_memberships)::int AS memberships`)
      ).rows[0];
      if (Object.values(counts).some((count) => count !== 0))
        throw new Error("reset_nonempty_identity_state");
      await admin.query("SET LOCAL search_path=api_next,pg_catalog");
      const digest = (
        await admin.query(
          "SELECT api_next.persona_community_binding_evidence_digest_v1() AS digest",
        )
      ).rows[0].digest;
      if (digest !== "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        throw new Error("reset_nonempty_evidence");
      return { counts, evidenceDigest: digest, ledgerCount: ledger.length };
    };
    await marker.advance("replaying", batches);
    for (let completed = 0; completed < plan.migrations.length; completed++) {
      await transaction(async (transactionId) => {
        await replayStagingMigrationBatch(admin, artifacts, {
          transactionId,
          schemaOid: admission.schemaOid,
          completed,
          ...admission.replayBudget,
        });
        if (completed === plan.migrations.length - 1) await verifyFinal(true);
      });
      await marker.advance("replaying", ++batches);
      await admission.afterBatch?.("replaying", batches);
    }
    await marker.advance("verifying", batches);
    const evidence = await transaction(() => verifyFinal());
    let releaseVerificationAttempted = false;
    return Object.freeze({
      batches,
      observedCommitBoundaryLocks: {
        maxOwnLocks,
        maxClusterLocks,
        maxClosureObjects,
        transientPeaksMayBeMissed: true,
      },
      evidence,
      awaitingPairedReleaseVerification: true,
      // Trusted caller verifies serving pair while the external fence remains held.
      async completeAfterPairedRelease(verifyServingPair: () => Promise<void>) {
        if (releaseVerificationAttempted)
          throw new Error("reset_release_retry_forbidden_restore_required");
        releaseVerificationAttempted = true;
        try {
          await admission.assertFreshFence();
          await verifyServingPair();
          await transaction(() => verifyFinal());
          await marker.completeAfterVerification();
        } catch (error) {
          await marker.advance("failed", batches).catch(() => undefined);
          throw error;
        }
      },
    });
  } catch (error) {
    await marker.advance("failed", batches).catch(() => undefined);
    // Do not remove marker, lift fence, retry batches, or resume from ledger.
    throw error;
  }
}
