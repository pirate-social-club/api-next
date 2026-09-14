import { Effect } from "effect";
import type { Client } from "pg";
import { applyPostgresMigrationsInTransaction } from "../packages/platform-cf/src/postgres-migrations.ts";
import { readPhasedResetCompletionEvidence } from "./staging-persona-completion-evidence.ts";
import {
  readResetDefaultAcls,
  readResetGrantCatalog,
  restoreResetDefaultAcls,
  verifyResetForbiddenGrants,
} from "./staging-persona-grant-catalog.ts";
import type { ResetGrant, ResetGrantPolicy } from "./staging-persona-grant-reconciliation.ts";
import { snapshotOutsideResetCatalog } from "./staging-persona-outside-catalog.ts";
import { migrationTransaction } from "./staging-persona-reconstruct.ts";
import { inspectStagingRemovalPlan } from "./staging-persona-removal-plan.ts";
import {
  denyReplayedRuntimeGrants,
  verifyResetRuntimeDenied,
} from "./staging-persona-reset-denied-grants.ts";
import { assertResetMarkerAbsent, createResetMarker } from "./staging-persona-reset-marker.ts";
import {
  assertStagingResetLedger,
  validateStagingResetArtifacts,
} from "./staging-persona-reset-plan.ts";
import { readResetSchemaShape } from "./staging-persona-schema-shape.ts";

const identifier = /^[a-z_][a-z0-9_]{0,62}$/u;
const emptyDigest = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function quote(value: string): string {
  if (!identifier.test(value)) throw new Error("reset_disposable_identifier_invalid");
  return `"${value}"`;
}

export type DisposableResetAdmission = Readonly<{
  markerDirectory: string;
  recoveryDigest: string;
  targetAndFenceDigest: string;
  validUntilMs: number;
  database: string;
  role: string;
  runtimeRole: string;
  schemaOid: number;
  defaultsDigest: string;
  baselineDigest: string;
  reviewedGrants: readonly ResetGrant[];
  grantPolicy: ResetGrantPolicy;
  replayBudget: { readonly statementTimeoutMs: number };
  assertFenceAndRecovery(): Promise<void>;
  assertBaselineReference(sourceSha: string, digest: string): Promise<void>;
  assertFreshFence(context: {
    readonly transactionId: string | null;
    readonly privilegeMode: "revoked";
  }): Promise<void>;
  withDatabaseCreate<T>(input: {
    readonly database: string;
    readonly ownerRole: string;
    readonly execute: () => Promise<T>;
  }): Promise<T>;
  onAdmissionStage?(stage: string): void;
}>;

type FinalEvidence = Readonly<{
  counts: Readonly<Record<string, number>>;
  evidenceDigest: string;
  ledgerCount: number;
  schemaOid: number;
}>;

/**
 * Replaces disposable staging rows and schema objects without replaying one
 * object per transaction. The external fences and recovery capture are still
 * mandatory. Schema destruction commits separately from replay so lock rows
 * from the old and new schemas never accumulate in one transaction; any later
 * failure leaves the marker and fences for capture restore.
 */
export async function reconstructDisposableStaging(
  admin: Pick<Client, "query">,
  artifacts: Parameters<typeof validateStagingResetArtifacts>[0],
  admission: DisposableResetAdmission,
) {
  const plan = validateStagingResetArtifacts(artifacts);
  if (!Number.isSafeInteger(admission.validUntilMs) || admission.validUntilMs <= Date.now()) {
    throw new Error("reset_admission_expired_restore_required");
  }
  if (!Number.isSafeInteger(admission.schemaOid) || admission.schemaOid < 1) {
    throw new Error("reset_disposable_schema_identity_invalid");
  }
  if (
    !Number.isSafeInteger(admission.replayBudget.statementTimeoutMs) ||
    admission.replayBudget.statementTimeoutMs < 1
  ) {
    throw new Error("reset_phase_budget_invalid");
  }
  quote(admission.role);
  quote(admission.runtimeRole);
  await assertResetMarkerAbsent(admission.markerDirectory);
  await admission.assertFenceAndRecovery();
  await admission.assertBaselineReference(plan.sourceSha, admission.baselineDigest);

  const transaction = async <T>(body: (transactionId: string) => Promise<T>): Promise<T> => {
    if (Date.now() >= admission.validUntilMs) {
      throw new Error("reset_admission_expired_restore_required");
    }
    await admission.assertFreshFence({ transactionId: null, privilegeMode: "revoked" });
    await verifyResetRuntimeDenied(admin, admission.runtimeRole);
    await admin.query("BEGIN ISOLATION LEVEL READ COMMITTED");
    try {
      await admin.query("SET LOCAL search_path=pg_catalog");
      await admin.query("SET LOCAL lock_timeout='2s'");
      await admin.query("SELECT set_config('statement_timeout',$1,true)", [
        `${admission.replayBudget.statementTimeoutMs}ms`,
      ]);
      const transactionId = (
        await admin.query("SELECT pg_catalog.pg_current_xact_id()::text AS id")
      ).rows[0]?.id;
      if (typeof transactionId !== "string") throw new Error("reset_transaction_unproven");
      const result = await body(transactionId);
      await admission.assertFreshFence({ transactionId, privilegeMode: "revoked" });
      await verifyResetRuntimeDenied(admin, admission.runtimeRole);
      if (Date.now() >= admission.validUntilMs) {
        throw new Error("reset_admission_expired_restore_required");
      }
      await admin.query("COMMIT");
      return result;
    } catch (error) {
      await admin.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  };

  admission.onAdmissionStage?.("inventory");
  const original = await transaction(async () => {
    const identity = (
      await admin.query(`SELECT current_database() AS database,session_user AS login,
        current_user AS active,n.oid,n.nspowner,r.rolname AS owner
        FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
        WHERE n.nspname='api_next'`)
    ).rows[0];
    if (
      identity?.database !== admission.database ||
      identity.login !== admission.role ||
      identity.active !== admission.role ||
      identity.oid !== admission.schemaOid ||
      identity.owner !== admission.role
    ) {
      throw new Error("reset_target_changed_restore_required");
    }
    const ledger = (
      await admin.query("SELECT version,checksum FROM api_next.schema_migrations ORDER BY version")
    ).rows;
    assertStagingResetLedger(plan, ledger);
    const defaults = await readResetDefaultAcls(admin);
    if (defaults.sha256 !== admission.defaultsDigest) {
      throw new Error("reset_default_acl_unreviewed");
    }
    await verifyResetForbiddenGrants(admin, admission.grantPolicy.forbidden);
    await inspectStagingRemovalPlan(admin, artifacts);
    return {
      defaults: defaults.facts,
      outside: (await snapshotOutsideResetCatalog(admin, { replaceableSchemaIdentity: true }))
        .sha256,
    };
  });

  const marker = await createResetMarker(admission.markerDirectory, {
    sourceSha: plan.sourceSha,
    recoveryDigest: admission.recoveryDigest,
    targetAndFenceDigest: admission.targetAndFenceDigest,
    validUntilMs: admission.validUntilMs,
  });
  let batches = 0;
  let schemaOid = admission.schemaOid;

  const verifyFinal = async (): Promise<FinalEvidence> => {
    await admin.query("SET LOCAL search_path=pg_catalog");
    const schema = (
      await admin.query(`SELECT n.oid,r.rolname AS owner FROM pg_catalog.pg_namespace n
        JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner WHERE n.nspname='api_next'`)
    ).rows[0];
    if (schema?.oid !== schemaOid || schema.owner !== admission.role) {
      throw new Error("reset_schema_identity_changed");
    }
    if ((await readResetSchemaShape(admin)).sha256 !== admission.baselineDigest) {
      throw new Error("reset_baseline_shape_mismatch");
    }
    await verifyResetForbiddenGrants(admin, admission.grantPolicy.forbidden);
    await verifyResetRuntimeDenied(admin, admission.runtimeRole);
    if ((await readResetGrantCatalog(admin)).defaults_sha256 !== admission.defaultsDigest) {
      throw new Error("reset_defaults_changed");
    }
    if (
      (await snapshotOutsideResetCatalog(admin, { replaceableSchemaIdentity: true })).sha256 !==
      original.outside
    ) {
      throw new Error("reset_outside_catalog_changed_restore_required");
    }
    const ledger = (
      await admin.query("SELECT version,checksum FROM api_next.schema_migrations ORDER BY version")
    ).rows;
    if (
      JSON.stringify(ledger) !==
      JSON.stringify(plan.migrations.map(({ version, checksum }) => ({ version, checksum })))
    ) {
      throw new Error("reset_final_ledger_changed");
    }
    const counts = (
      await admin.query(`SELECT
        (SELECT count(*) FROM api_next.users)::int AS users,
        (SELECT count(*) FROM api_next.personas)::int AS personas,
        (SELECT count(*) FROM api_next.persona_community_bindings)::int AS bindings,
        (SELECT count(*) FROM api_next.communities)::int AS communities,
        (SELECT count(*) FROM api_next.community_memberships)::int AS memberships`)
    ).rows[0] as Record<string, number>;
    if (Object.values(counts).some((count) => count !== 0)) {
      throw new Error("reset_nonempty_identity_state");
    }
    await admin.query("SET LOCAL search_path=api_next,pg_catalog");
    const evidenceDigest = (
      await admin.query("SELECT api_next.persona_community_binding_evidence_digest_v1() AS digest")
    ).rows[0]?.digest;
    if (evidenceDigest !== emptyDigest) throw new Error("reset_nonempty_evidence");
    return { counts, evidenceDigest, ledgerCount: ledger.length, schemaOid };
  };

  try {
    admission.onAdmissionStage?.("first_batch");
    await marker.advance("removing", batches);
    schemaOid = await admission.withDatabaseCreate({
      database: admission.database,
      ownerRole: admission.role,
      execute: () =>
        transaction(async () => {
          await admin.query("DROP SCHEMA api_next CASCADE");
          await admin.query(`CREATE SCHEMA api_next AUTHORIZATION ${quote(admission.role)}`);
          // Default ACLs are namespace-scoped and do not survive the drop. They
          // are recreated here so replayed and later migration objects carry
          // the reviewed runtime grants without the reset restoring access the
          // held database fence must keep denied.
          await restoreResetDefaultAcls(admin, original.defaults);
          const next = (
            await admin.query("SELECT oid FROM pg_catalog.pg_namespace WHERE nspname='api_next'")
          ).rows[0]?.oid;
          if (!Number.isSafeInteger(next) || next === admission.schemaOid) {
            throw new Error("reset_disposable_schema_replacement_unproven");
          }
          return next as number;
        }),
    });
    if (
      (await snapshotOutsideResetCatalog(admin, { replaceableSchemaIdentity: true })).sha256 !==
      original.outside
    ) {
      throw new Error("reset_outside_catalog_changed_restore_required");
    }
    await marker.advance("removing", ++batches);
    admission.onAdmissionStage?.("admitted");

    await marker.advance("replaying", batches);
    await transaction(async () => {
      await admin.query("SET LOCAL search_path=api_next,pg_catalog");
      await Effect.runPromise(
        applyPostgresMigrationsInTransaction(migrationTransaction(admin), plan.migrations),
      );
      // The runtime stays denied until the release's database surface restores
      // the reviewed grants after the upgrade; the fence contract declares
      // `database: restored` only at that surface.
      await denyReplayedRuntimeGrants(admin, admission.runtimeRole);
      await verifyFinal();
    });
    await marker.advance("replaying", ++batches);
    await marker.advance("verifying", batches);
    const evidence = await transaction(verifyFinal);
    const readCompletion = () =>
      readPhasedResetCompletionEvidence(admin, {
        database: admission.database,
        role: admission.role,
        schemaOid,
        baselineDigest: admission.baselineDigest,
        migrations: plan.migrations,
      });
    let releaseAttempted = false;
    return Object.freeze({
      batches,
      evidence,
      executionEvidence: (await transaction(readCompletion)).proof,
      awaitingPairedReleaseVerification: true,
      async verifyResetCompletion() {
        if (releaseAttempted) throw new Error("reset_completion_release_already_attempted");
        return (await transaction(readCompletion)).completion;
      },
      async completeAfterPairedRelease(verifyServingPair: () => Promise<void>) {
        if (releaseAttempted) throw new Error("reset_release_retry_forbidden_restore_required");
        releaseAttempted = true;
        try {
          await admission.assertFreshFence({ transactionId: null, privilegeMode: "revoked" });
          await verifyServingPair();
          await transaction(verifyFinal);
          await marker.completeAfterVerification();
        } catch (error) {
          await marker.advance("failed", batches).catch(() => undefined);
          throw error;
        }
      },
    });
  } catch (error) {
    await marker.advance("failed", batches).catch(() => undefined);
    throw error;
  }
}
