import { randomUUID } from "node:crypto";
import { redactedDiagnosticCause } from "@pirate/application/namespace-ownership";
import {
  HNS_AUTHORITY_SERVICE_VERSION,
  HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
} from "../apps/hns-authority-provisioner/src/schema-compatibility.ts";
import {
  assertMigrationsWithinEndpoint,
  HNS_READINESS_CUTOVER_ENDPOINT,
  type HnsExecutorProgress,
  type HnsReadinessCutoverBundle,
  HnsReadinessCutoverRefused,
  type HnsRunningIdentity,
  hnsExecutorProgressRefusal,
  hnsRunningIdentityRefusal,
  pollCutoverIdentity,
} from "./hns-readiness-cutover.ts";
import {
  HNS_STAGING_SERVICE_UNIT,
  type HnsStagingAuthorizedTarget,
  type HnsStagingMigration,
  type HnsStagingPostMigrationInput,
  type HnsStagingPostMigrationRefusal,
  type HnsStagingPostMigrationResult,
  type HnsStagingPostMigrationStep,
  type HnsStagingPrivilegeMatrix,
  type HnsStagingPrivilegeRow,
  type HnsStagingRecoveryReceipt,
  type HnsStagingServiceDisposition,
  type HnsStagingTargetBinding,
} from "./staging-hns-post-migration-contract.ts";

/**
 * The delegated HNS post-migration entry point for the staging reset
 * orchestrator.
 *
 * The staging reset lane owns every migration: a fresh reset replays the chain
 * one migration per transaction through the phased reset, and the in-place
 * preflight/removal batch is the orchestrator's own sequence. This entry point
 * therefore applies no migrations at all. It refuses unless the migration
 * ledger already ends exactly at the reviewed cutover endpoint with matching
 * checksums, and only then verifies the runtime and operator identities,
 * applies the reviewed grants, reads back the effective privilege matrix,
 * stages the release bundle and manifest under a fresh attempt identifier,
 * seeds the controlled probe, starts the explicitly named staging service
 * unit, and records schema compatibility, the measured running identity and
 * executor progress as three separate results bound to that exact attempt.
 *
 * Step implementations and polling are shared with `hns-readiness-cutover.ts`
 * so the in-place cutover and this staging path cannot drift.
 */

const ROLE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/u;
const ATTEMPT_IDENTIFIER = /^[A-Za-z0-9._:-]{8,128}$/u;

export function isHnsStagingRoleIdentifier(value: string): boolean {
  return ROLE_IDENTIFIER.test(value);
}

export class HnsStagingPostMigrationRefused extends Error {
  readonly refusal: HnsStagingPostMigrationRefusal;

  constructor(refusal: HnsStagingPostMigrationRefusal) {
    super(`HNS staging post-migration refused at ${refusal.step}: ${refusal.reason}`);
    this.name = "HnsStagingPostMigrationRefused";
    this.refusal = refusal;
  }
}

export function postMigrationRefusalJson(refusal: HnsStagingPostMigrationRefusal): string {
  return JSON.stringify(refusal);
}

function refused(
  step: HnsStagingPostMigrationStep,
  reason: string,
  detail?: Readonly<Record<string, unknown>>,
): HnsStagingPostMigrationRefused {
  return new HnsStagingPostMigrationRefused({
    outcome: "post_migration_refused",
    step,
    reason,
    ...(detail === undefined ? {} : { detail }),
  });
}

function boundedCause(error: unknown): string | null {
  return redactedDiagnosticCause(error)?.slice(0, 200) ?? null;
}

async function readPort<A>(
  step: HnsStagingPostMigrationStep,
  reason: string,
  read: () => Promise<A>,
): Promise<A> {
  try {
    return await read();
  } catch (error) {
    throw refused(step, reason, { cause: boundedCause(error) });
  }
}

/**
 * Refuses unless the applied ledger is exactly the pinned chain through the
 * reviewed endpoint. A migration beyond the endpoint on either side, a missing
 * row, an unpinned row and a checksum mismatch are each named. This is the
 * guard that keeps a failed reset replay from reaching post-migration work.
 */
export function verifyStagingMigrationLedger(input: {
  readonly pinned: readonly HnsStagingMigration[];
  readonly ledger: readonly HnsStagingMigration[];
  readonly endpoint?: string;
}): Readonly<{ readonly applied: number }> {
  const endpoint = input.endpoint ?? HNS_READINESS_CUTOVER_ENDPOINT;
  const step: HnsStagingPostMigrationStep = "target_and_ledger";
  try {
    assertMigrationsWithinEndpoint(input.pinned, endpoint);
  } catch (error) {
    if (error instanceof HnsReadinessCutoverRefused) {
      throw refused(step, "migration_endpoint_exceeded", error.refusal.detail);
    }
    throw error;
  }
  const ledger = [...input.ledger].sort((left, right) =>
    left.version < right.version ? -1 : left.version > right.version ? 1 : 0,
  );
  const beyond = ledger.find((row) => row.version > endpoint);
  if (beyond !== undefined) {
    throw refused(step, "migration_endpoint_exceeded", { first_beyond: beyond.version });
  }
  const last = ledger.at(-1);
  if (last === undefined || last.version !== endpoint) {
    throw refused(step, "migration_endpoint_missing", {
      expected: endpoint,
      actual: last?.version ?? null,
    });
  }
  const pinnedByVersion = new Map(input.pinned.map((migration) => [migration.version, migration]));
  const ledgerByVersion = new Map(ledger.map((row) => [row.version, row]));
  for (const migration of input.pinned) {
    if (migration.version > endpoint) continue;
    const applied = ledgerByVersion.get(migration.version);
    if (applied === undefined) {
      throw refused(step, "migration_missing", { version: migration.version });
    }
    if (applied.checksum !== migration.checksum) {
      throw refused(step, "checksum_mismatch", { version: migration.version });
    }
  }
  for (const row of ledger) {
    if (!pinnedByVersion.has(row.version)) {
      throw refused(step, "migration_not_pinned", { version: row.version });
    }
  }
  return { applied: ledger.length };
}

/** The reviewed effective privilege matrix: the runtime identity executes the
 * six-argument probe, and neither identity holds a direct write on the service
 * identity table. */
function verifyStagingPrivilegeMatrix(
  matrix: HnsStagingPrivilegeMatrix,
  runtimeRole: string,
  operatorRole: string,
): void {
  if (matrix.runtime.probe_execute !== true) {
    throw refused("privilege_matrix", "probe_execute_missing", { role: runtimeRole });
  }
  const rows: readonly [string, string, HnsStagingPrivilegeRow][] = [
    ["runtime", runtimeRole, matrix.runtime],
    ["operator", operatorRole, matrix.operator],
  ];
  for (const [kind, role, row] of rows) {
    for (const privilege of ["identity_insert", "identity_update", "identity_delete"] as const) {
      if (row[privilege] === true) {
        throw refused("privilege_matrix", "identity_write_allowed", {
          identity_kind: kind,
          role,
          privilege: privilege.slice("identity_".length).toUpperCase(),
        });
      }
    }
  }
}

function verifyAuthorizedTarget(
  authorized: HnsStagingAuthorizedTarget,
  binding: HnsStagingTargetBinding,
): void {
  if (
    binding.database_id !== authorized.database_id ||
    binding.database_name !== authorized.database_name
  ) {
    throw refused("target_and_ledger", "target_database_mismatch", {
      expected_database_id: authorized.database_id,
      actual_database_id: binding.database_id.slice(0, 64),
      expected_database_name: authorized.database_name,
      actual_database_name: binding.database_name.slice(0, 64),
    });
  }
  if (
    binding.branch_id !== authorized.branch_id ||
    binding.branch_name !== authorized.branch_name
  ) {
    throw refused("target_and_ledger", "target_branch_mismatch", {
      expected_branch_id: authorized.branch_id,
      actual_branch_id: binding.branch_id.slice(0, 64),
      expected_branch_name: authorized.branch_name,
      actual_branch_name: binding.branch_name.slice(0, 64),
    });
  }
  if (binding.branch_ready !== true) {
    throw refused("target_and_ledger", "target_not_ready", {
      branch_id: binding.branch_id.slice(0, 64),
    });
  }
  if (binding.sql_database !== authorized.sql_database) {
    throw refused("target_and_ledger", "target_database_mismatch", {
      expected_sql_database: authorized.sql_database,
      actual_sql_database: binding.sql_database.slice(0, 64),
    });
  }
}

function verifyIdentities(
  authorized: HnsStagingAuthorizedTarget,
  roles: Readonly<{
    readonly migrator: string;
    readonly runtime: string;
    readonly operator: string;
  }>,
  providerMigratorRole: string,
): void {
  if (providerMigratorRole !== authorized.migrator_role) {
    throw refused("identities", "migrator_role_mismatch", {
      source: "provider_binding",
      expected_migrator_role: authorized.migrator_role,
      actual_migrator_role: providerMigratorRole.slice(0, 64),
    });
  }
  if (roles.runtime === roles.migrator) {
    throw refused("identities", "runtime_migrator_conflict", {
      role: roles.runtime.slice(0, 64),
    });
  }
  if (roles.operator === roles.runtime) {
    throw refused("identities", "runtime_operator_conflict", {
      role: roles.runtime.slice(0, 64),
    });
  }
  if (roles.runtime !== authorized.runtime_role) {
    throw refused("identities", "runtime_role_mismatch", {
      expected_runtime_role: authorized.runtime_role,
      actual_runtime_role: roles.runtime.slice(0, 64),
    });
  }
  if (roles.operator !== authorized.operator_role) {
    throw refused("identities", "operator_role_mismatch", {
      expected_operator_role: authorized.operator_role,
      actual_operator_role: roles.operator.slice(0, 64),
    });
  }
  if (roles.migrator !== authorized.migrator_role) {
    throw refused("identities", "migrator_role_mismatch", {
      expected_migrator_role: authorized.migrator_role,
      actual_migrator_role: roles.migrator.slice(0, 64),
    });
  }
}

export async function runHnsStagingPostMigration(
  input: HnsStagingPostMigrationInput,
): Promise<HnsStagingPostMigrationResult> {
  const { authorized, release, ports } = input;
  const results: { step: HnsStagingPostMigrationStep; result: Record<string, unknown> }[] = [];
  const push = (step: HnsStagingPostMigrationStep, result: Record<string, unknown>) => {
    results.push({ step, result });
  };

  if (authorized.service_unit !== HNS_STAGING_SERVICE_UNIT) {
    throw refused("target_and_ledger", "service_unit_not_staging", {
      expected_service_unit: HNS_STAGING_SERVICE_UNIT,
      actual_service_unit: authorized.service_unit.slice(0, 128),
    });
  }
  if (
    release.service_version !== HNS_AUTHORITY_SERVICE_VERSION ||
    release.job_envelope_version !== HNS_LIFECYCLE_JOB_ENVELOPE_VERSION
  ) {
    throw refused("target_and_ledger", "release_identity_mismatch", {
      expected_service_version: HNS_AUTHORITY_SERVICE_VERSION,
      expected_job_envelope_version: HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
      actual_service_version: release.service_version.slice(0, 128),
      actual_job_envelope_version: release.job_envelope_version.slice(0, 128),
    });
  }

  // Step 1: authorized target, pinned release and the exact applied ledger.
  const binding = await readPort("target_and_ledger", "target_binding_unproven", () =>
    ports.readTargetBinding(),
  );
  verifyAuthorizedTarget(authorized, binding);
  const ledger = await readPort("target_and_ledger", "migration_ledger_unavailable", () =>
    ports.readMigrationLedger(),
  );
  const pinned = await readPort("target_and_ledger", "migration_manifest_unavailable", () =>
    ports.readPinnedMigrations(),
  );
  const applied = verifyStagingMigrationLedger({ pinned, ledger });
  push("target_and_ledger", {
    database_id: authorized.database_id,
    branch_id: authorized.branch_id,
    sql_database: authorized.sql_database,
    endpoint: HNS_READINESS_CUTOVER_ENDPOINT,
    applied_migrations: applied.applied,
  });

  // Step 2: actual runtime and operator identities, and the migrator conflict.
  const migratorRole = await readPort("identities", "migrator_identity_unproven", () =>
    ports.readMigratorIdentity(),
  );
  const runtimeRole = await readPort("identities", "runtime_identity_unproven", () =>
    ports.readRuntimeIdentity(),
  );
  const operatorRole = await readPort("identities", "operator_identity_unproven", () =>
    ports.readOperatorIdentity(),
  );
  for (const role of [migratorRole, runtimeRole, operatorRole]) {
    if (!ROLE_IDENTIFIER.test(role)) {
      throw refused("identities", "role_identifier_invalid", { role: role.slice(0, 64) });
    }
  }
  verifyIdentities(
    authorized,
    {
      migrator: migratorRole,
      runtime: runtimeRole,
      operator: operatorRole,
    },
    binding.migrator_role,
  );
  push("identities", {
    runtime_role: runtimeRole,
    operator_role: operatorRole,
    migrator_role: migratorRole,
  });

  // Step 3: the reviewed grants on those identities.
  try {
    await ports.applyReviewedGrants({ runtime_role: runtimeRole, operator_role: operatorRole });
  } catch (error) {
    throw refused("grants", "grant_application_failed", { cause: boundedCause(error) });
  }
  push("grants", {
    runtime_role: runtimeRole,
    operator_role: operatorRole,
    probe_execute_granted: true,
    identity_table_writes_revoked: true,
  });

  // Step 4: the effective privilege matrix readback is the proof.
  const matrix = await readPort("privilege_matrix", "privilege_matrix_unavailable", () =>
    ports.readPrivilegeMatrix({ runtime_role: runtimeRole, operator_role: operatorRole }),
  );
  verifyStagingPrivilegeMatrix(matrix, runtimeRole, operatorRole);
  push("privilege_matrix", {
    runtime_probe_execute: matrix.runtime.probe_execute,
    runtime_identity_insert: matrix.runtime.identity_insert,
    runtime_identity_update: matrix.runtime.identity_update,
    runtime_identity_delete: matrix.runtime.identity_delete,
  });

  // Step 5: a fresh attempt identifier and the staged bundle/manifest binding.
  const attemptId = (input.new_attempt_id ?? randomUUID)();
  if (!ATTEMPT_IDENTIFIER.test(attemptId)) {
    throw refused("bundle", "attempt_identifier_invalid", { attempt_id: attemptId.slice(0, 64) });
  }
  const stagedBundle: HnsReadinessCutoverBundle = { ...input.bundle, attempt_id: attemptId };
  try {
    await ports.stageBundle({ bundle: stagedBundle, stage_directory: input.stage_directory });
  } catch (error) {
    throw refused("bundle", "bundle_staging_failed", { cause: boundedCause(error) });
  }
  push("bundle", {
    attempt_id: attemptId,
    bundle_sha256: stagedBundle.bundle_sha256,
    stage_directory: input.stage_directory.slice(0, 256),
  });

  // Step 6: seed the controlled probe.
  try {
    await ports.seedExecutionProbe();
  } catch (error) {
    throw refused("probe", "probe_seed_failed", { cause: boundedCause(error) });
  }
  push("probe", { seeded: true });

  // Step 7: start the explicitly named staging unit.
  try {
    await ports.startService(authorized.service_unit);
  } catch (error) {
    throw refused("service", "service_start_failed", { cause: boundedCause(error) });
  }
  push("service", { unit: authorized.service_unit, started: true });

  const startedDisposition = (): Readonly<{
    service_disposition: HnsStagingServiceDisposition;
    recovery: HnsStagingRecoveryReceipt;
  }> => ({
    service_disposition: {
      unit: authorized.service_unit,
      started: true,
      disposition: "started_unverified",
      attempt_id: attemptId,
    },
    recovery: {
      resumable: true,
      stop_service_before_rerun: true,
      attempt_id: attemptId,
    },
  });
  const failAfterStart = (error: HnsStagingPostMigrationRefused) =>
    new HnsStagingPostMigrationRefused({ ...error.refusal, ...startedDisposition() });

  // Step 8: schema compatibility, measured running identity and executor
  // progress, each as its own result, all bound to this exact attempt.
  let compatibility: string;
  try {
    compatibility = await ports.readSchemaCompatibility({
      service_version: release.service_version,
      job_envelope_version: release.job_envelope_version,
    });
  } catch (error) {
    throw failAfterStart(
      refused("schema_compatibility", "schema_compatibility_unavailable", {
        cause: boundedCause(error),
      }),
    );
  }
  if (compatibility !== "compatible" && compatibility !== "pre_cutover") {
    throw failAfterStart(
      refused("schema_compatibility", "schema_incompatible", {
        compatibility: compatibility.slice(0, 64),
      }),
    );
  }
  push("schema_compatibility", { compatibility });

  let identity: HnsRunningIdentity | null;
  try {
    identity = await pollCutoverIdentity({
      attempt_id: attemptId,
      read_identity: ports.readCutoverIdentity,
      ...(input.identity_poll === undefined ? {} : input.identity_poll),
    });
  } catch (error) {
    throw failAfterStart(
      refused("service_identity", "service_identity_unavailable", { cause: boundedCause(error) }),
    );
  }
  if (identity === null) {
    throw failAfterStart(refused("service_identity", "service_never_started"));
  }
  const identityDecision = hnsRunningIdentityRefusal(identity, stagedBundle);
  if (identityDecision !== null) {
    throw failAfterStart(
      refused("service_identity", identityDecision.reason, identityDecision.detail),
    );
  }
  push("service_identity", {
    attempt_id: identity.attempt_id,
    bundle_sha256: identity.bundle_sha256,
    measured_bundle_sha256: identity.measured_bundle_sha256,
    probe_job_id: identity.probe_job_id,
    lease_fence: identity.lease_fence,
  });

  let progress: HnsExecutorProgress | null;
  try {
    const identityForProgress = await pollCutoverIdentity({
      attempt_id: attemptId,
      read_identity: ports.readCutoverIdentity,
      ...(input.identity_poll === undefined ? {} : input.identity_poll),
    });
    progress =
      identityForProgress === null
        ? null
        : {
            probe_outcome: identityForProgress.probe_outcome,
            probe_reason: identityForProgress.probe_reason,
            probe_fresh: identityForProgress.probe_fresh,
          };
  } catch (error) {
    throw failAfterStart(
      refused("executor_progress", "executor_progress_unavailable", { cause: boundedCause(error) }),
    );
  }
  const progressDecision = hnsExecutorProgressRefusal(progress);
  if (progressDecision !== null) {
    throw failAfterStart(
      refused("executor_progress", progressDecision.reason, progressDecision.detail),
    );
  }
  push("executor_progress", {
    probe_outcome: progress?.probe_outcome ?? "absent",
    probe_fresh: progress?.probe_fresh ?? false,
  });

  return Object.freeze({
    outcome: "post_migration_applied",
    attempt_id: attemptId,
    results: Object.freeze(results.map((entry) => Object.freeze(entry))),
  });
}
