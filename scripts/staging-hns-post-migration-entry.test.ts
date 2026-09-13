import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import {
  HNS_AUTHORITY_SERVICE_VERSION,
  HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
} from "../apps/hns-authority-provisioner/src/schema-compatibility.ts";
import type { CutoverIdentityRow } from "./hns-readiness-cutover.ts";
import {
  HNS_STAGING_BRANCH_ID,
  HNS_STAGING_BRANCH_NAME,
  HNS_STAGING_DATABASE_ID,
  HNS_STAGING_PROVIDER_DATABASE_NAME,
  HNS_STAGING_SERVICE_UNIT,
  HNS_STAGING_SQL_DATABASE,
  type HnsStagingAuthorizedTarget,
  type HnsStagingPostMigrationPorts,
} from "./staging-hns-post-migration-contract.ts";
import {
  HnsStagingPostMigrationRefused,
  postMigrationRefusalJson,
  runHnsStagingPostMigration,
} from "./staging-hns-post-migration-entry.ts";
import { postMigrationFailureJson } from "./staging-hns-post-migration-runtime.ts";

const endpoint = "0172_hns_cutover_evidence_consistency.sql";
const bundleSha = "a".repeat(64);
const attemptId = "attempt-00000001";
const executorId = "staging-executor-1";

const pinnedMigrations = [
  { version: "0168_hns_readiness_cutover_preflight.sql", checksum: "1".repeat(64) },
  { version: "0169_hns_single_owner_readiness_cutover.sql", checksum: "2".repeat(64) },
  { version: "0170_hns_renewal_authoritative_evidence.sql", checksum: "3".repeat(64) },
  { version: "0171_hns_cutover_execution_probe.sql", checksum: "4".repeat(64) },
  { version: endpoint, checksum: "5".repeat(64) },
];

const authorizedTarget: HnsStagingAuthorizedTarget = {
  database_id: HNS_STAGING_DATABASE_ID,
  database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
  sql_database: HNS_STAGING_SQL_DATABASE,
  branch_id: HNS_STAGING_BRANCH_ID,
  branch_name: HNS_STAGING_BRANCH_NAME,
  runtime_role: "runtime_role",
  operator_role: "operator_role",
  migrator_role: "migrator_role",
  service_unit: HNS_STAGING_SERVICE_UNIT,
};

function identityRow(overrides: Partial<CutoverIdentityRow> = {}): CutoverIdentityRow {
  return {
    attempt_id: attemptId,
    bundle_sha256: bundleSha,
    measured_bundle_sha256: bundleSha,
    expected_bundle_sha256: bundleSha,
    service_version: HNS_AUTHORITY_SERVICE_VERSION,
    executor_id: executorId,
    probe_job_id: "7",
    lease_fence: "1",
    probe_outcome: "ready",
    probe_reason: null,
    probe_completed_at: new Date(),
    probe_fresh: true,
    ...overrides,
  };
}

function makePorts(overrides: Partial<HnsStagingPostMigrationPorts> = {}): {
  readonly ports: HnsStagingPostMigrationPorts;
  readonly events: string[];
  readonly staged: { attempt_id: string; stage_directory: string }[];
} {
  const events: string[] = [];
  const staged: { attempt_id: string; stage_directory: string }[] = [];
  const ports: HnsStagingPostMigrationPorts = {
    readTargetBinding: async () => {
      events.push("binding");
      return {
        database_id: HNS_STAGING_DATABASE_ID,
        database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
        sql_database: HNS_STAGING_SQL_DATABASE,
        branch_id: HNS_STAGING_BRANCH_ID,
        branch_name: HNS_STAGING_BRANCH_NAME,
        branch_ready: true,
        migrator_role: "migrator_role",
      };
    },
    readMigrationLedger: async () => {
      events.push("ledger");
      return pinnedMigrations.map((migration) => ({ ...migration }));
    },
    readPinnedMigrations: async () => {
      events.push("pinned");
      return pinnedMigrations.map((migration) => ({ ...migration }));
    },
    readMigratorIdentity: async () => {
      events.push("migrator");
      return "migrator_role";
    },
    readRuntimeIdentity: async () => {
      events.push("runtime");
      return "runtime_role";
    },
    readOperatorIdentity: async () => {
      events.push("operator");
      return "operator_role";
    },
    applyReviewedGrants: async () => {
      events.push("grants");
    },
    readPrivilegeMatrix: async () => {
      events.push("matrix");
      return {
        runtime: {
          probe_execute: true,
          identity_insert: false,
          identity_update: false,
          identity_delete: false,
        },
        operator: {
          probe_execute: false,
          identity_insert: false,
          identity_update: false,
          identity_delete: false,
        },
      };
    },
    stageBundle: async ({ bundle, stage_directory }) => {
      events.push("stage");
      staged.push({ attempt_id: bundle.attempt_id, stage_directory });
    },
    seedExecutionProbe: async () => {
      events.push("seed");
    },
    startService: async () => {
      events.push("start");
    },
    readSchemaCompatibility: async () => {
      events.push("compatibility");
      return "compatible";
    },
    readCutoverIdentity: async () => {
      events.push("identity");
      return identityRow();
    },
    ...overrides,
  };
  return { ports, events, staged };
}

function makeInput(ports: HnsStagingPostMigrationPorts) {
  return {
    authorized: authorizedTarget,
    release: {
      service_version: HNS_AUTHORITY_SERVICE_VERSION,
      job_envelope_version: HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
    },
    bundle: {
      bundle_path: "/stage/source/pirate-hns-authority-provisioner.mjs",
      bundle_sha256: bundleSha,
      service_version: HNS_AUTHORITY_SERVICE_VERSION,
      job_envelope_version: HNS_LIFECYCLE_JOB_ENVELOPE_VERSION,
      executor_id: executorId,
    },
    stage_directory: "/srv/pirate-hns-authority-provisioner-staging/current",
    ports,
    new_attempt_id: () => attemptId,
    identity_poll: { timeout_ms: 0 },
  };
}

async function refusalOf(run: () => Promise<unknown>): Promise<Readonly<Record<string, unknown>>> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(HnsStagingPostMigrationRefused);
    return (error as HnsStagingPostMigrationRefused).refusal as unknown as Record<string, unknown>;
  }
  throw new Error("expected a refusal");
}

describe("HNS staging post-migration entry point", () => {
  test("runs the ten named steps in order and stages the fresh attempt", async () => {
    const { ports, events, staged } = makePorts();
    const result = await runHnsStagingPostMigration(makeInput(ports));
    expect(events).toEqual([
      "binding",
      "ledger",
      "pinned",
      "migrator",
      "runtime",
      "operator",
      "grants",
      "matrix",
      "stage",
      "seed",
      "start",
      "compatibility",
      "identity",
      "identity",
    ]);
    expect(result.outcome).toBe("post_migration_applied");
    expect(result.attempt_id).toBe(attemptId);
    expect(result.results.map((entry) => entry.step)).toEqual([
      "target_and_ledger",
      "identities",
      "grants",
      "privilege_matrix",
      "bundle",
      "probe",
      "service",
      "schema_compatibility",
      "service_identity",
      "executor_progress",
    ]);
    expect(staged).toEqual([
      {
        attempt_id: attemptId,
        stage_directory: "/srv/pirate-hns-authority-provisioner-staging/current",
      },
    ]);
  });

  test("applies no migrations by construction", async () => {
    const entry = await readFile(
      new URL("./staging-hns-post-migration-entry.ts", import.meta.url),
      "utf8",
    );
    const runtime = await readFile(
      new URL("./staging-hns-post-migration-runtime.ts", import.meta.url),
      "utf8",
    );
    for (const source of [entry, runtime]) {
      expect(source).not.toContain("runPostgresMigrations");
      expect(source).not.toContain("applyPreflight");
      expect(source).not.toContain("applyRemoval");
    }
    // The entry's port surface has no migration port to call.
    const { ports } = makePorts();
    expect(Object.keys(ports).sort()).toEqual([
      "applyReviewedGrants",
      "readCutoverIdentity",
      "readMigrationLedger",
      "readMigratorIdentity",
      "readOperatorIdentity",
      "readPinnedMigrations",
      "readPrivilegeMatrix",
      "readRuntimeIdentity",
      "readSchemaCompatibility",
      "readTargetBinding",
      "seedExecutionProbe",
      "stageBundle",
      "startService",
    ]);
  });

  test("refuses a wrong authorized database before any identity work", async () => {
    const { ports, events } = makePorts({
      readTargetBinding: async () => ({
        database_id: "other-database",
        database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
        sql_database: HNS_STAGING_SQL_DATABASE,
        branch_id: HNS_STAGING_BRANCH_ID,
        branch_name: HNS_STAGING_BRANCH_NAME,
        branch_ready: true,
        migrator_role: "migrator_role",
      }),
    });
    const refusal = await refusalOf(() => runHnsStagingPostMigration(makeInput(ports)));
    expect(refusal).toMatchObject({
      step: "target_and_ledger",
      reason: "target_database_mismatch",
    });
    expect(events).toEqual([]);
  });

  test("refuses a wrong branch and a not-ready branch", async () => {
    const wrongBranch = makePorts({
      readTargetBinding: async () => ({
        database_id: HNS_STAGING_DATABASE_ID,
        database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
        sql_database: HNS_STAGING_SQL_DATABASE,
        branch_id: "other-branch",
        branch_name: HNS_STAGING_BRANCH_NAME,
        branch_ready: true,
        migrator_role: "migrator_role",
      }),
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(wrongBranch.ports))),
    ).toMatchObject({ step: "target_and_ledger", reason: "target_branch_mismatch" });

    const notReady = makePorts({
      readTargetBinding: async () => ({
        database_id: HNS_STAGING_DATABASE_ID,
        database_name: HNS_STAGING_PROVIDER_DATABASE_NAME,
        sql_database: HNS_STAGING_SQL_DATABASE,
        branch_id: HNS_STAGING_BRANCH_ID,
        branch_name: HNS_STAGING_BRANCH_NAME,
        branch_ready: false,
        migrator_role: "migrator_role",
      }),
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(notReady.ports))),
    ).toMatchObject({ step: "target_and_ledger", reason: "target_not_ready" });
  });

  test("refuses a wrong release identity or a non-staging unit before any port", async () => {
    const { ports, events } = makePorts();
    const wrongRelease = await refusalOf(() =>
      runHnsStagingPostMigration({
        ...makeInput(ports),
        release: {
          service_version: HNS_AUTHORITY_SERVICE_VERSION,
          job_envelope_version: "other-envelope",
        },
      }),
    );
    expect(wrongRelease).toMatchObject({
      step: "target_and_ledger",
      reason: "release_identity_mismatch",
    });
    const wrongUnit = await refusalOf(() =>
      runHnsStagingPostMigration({
        ...makeInput(ports),
        authorized: {
          ...authorizedTarget,
          service_unit: "pirate-hns-authority-provisioner.service",
        },
      }),
    );
    expect(wrongUnit).toMatchObject({
      step: "target_and_ledger",
      reason: "service_unit_not_staging",
    });
    expect(events).toEqual([]);
  });

  test("refuses a ledger that ends before the endpoint", async () => {
    const { ports, events } = makePorts({
      readMigrationLedger: async () => {
        events.push("ledger");
        return pinnedMigrations.slice(0, 2).map((migration) => ({ ...migration }));
      },
    });
    const refusal = await refusalOf(() => runHnsStagingPostMigration(makeInput(ports)));
    expect(refusal).toMatchObject({
      step: "target_and_ledger",
      reason: "migration_endpoint_missing",
      detail: { expected: endpoint, actual: "0169_hns_single_owner_readiness_cutover.sql" },
    });
    expect(events).not.toContain("grants");
    expect(events).not.toContain("stage");
    expect(events).not.toContain("start");
  });

  test("refuses a missing migration, a checksum mismatch and an unpinned row", async () => {
    const missing = makePorts({
      readMigrationLedger: async () => {
        const rows = pinnedMigrations.map((migration) => ({ ...migration }));
        return [rows[0], rows[1], rows[3], rows[4]] as typeof rows;
      },
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(missing.ports))),
    ).toMatchObject({
      step: "target_and_ledger",
      reason: "migration_missing",
      detail: { version: "0170_hns_renewal_authoritative_evidence.sql" },
    });

    const mismatch = makePorts({
      readMigrationLedger: async () =>
        pinnedMigrations.map((migration) =>
          migration.version === endpoint
            ? { ...migration, checksum: "f".repeat(64) }
            : { ...migration },
        ),
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(mismatch.ports))),
    ).toMatchObject({
      step: "target_and_ledger",
      reason: "checksum_mismatch",
      detail: { version: endpoint },
    });

    const unpinned = makePorts({
      readMigrationLedger: async () => [
        ...pinnedMigrations.map((migration) => ({ ...migration })),
        { version: "0169z_unpinned_followup.sql", checksum: "6".repeat(64) },
      ],
    });
    const unpinnedRefusal = await refusalOf(() =>
      runHnsStagingPostMigration(makeInput(unpinned.ports)),
    );
    expect(unpinnedRefusal).toMatchObject({
      step: "target_and_ledger",
      reason: "migration_not_pinned",
    });
  });

  test("refuses a migration beyond the reviewed endpoint on either side", async () => {
    const ledgerBeyond = makePorts({
      readMigrationLedger: async () => [
        ...pinnedMigrations.map((migration) => ({ ...migration })),
        { version: "0173_unreviewed.sql", checksum: "9".repeat(64) },
      ],
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(ledgerBeyond.ports))),
    ).toMatchObject({
      step: "target_and_ledger",
      reason: "migration_endpoint_exceeded",
      detail: { first_beyond: "0173_unreviewed.sql" },
    });

    const pinnedBeyond = makePorts({
      readPinnedMigrations: async () => [
        ...pinnedMigrations.map((migration) => ({ ...migration })),
        { version: "0173_unreviewed.sql", checksum: "9".repeat(64) },
      ],
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(pinnedBeyond.ports))),
    ).toMatchObject({
      step: "target_and_ledger",
      reason: "migration_endpoint_exceeded",
      detail: { endpoint, first_beyond: "0173_unreviewed.sql" },
    });
  });

  test("refuses wrong role mappings and migrator conflicts", async () => {
    const wrongRuntime = makePorts({
      readRuntimeIdentity: async () => "other_runtime",
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(wrongRuntime.ports))),
    ).toMatchObject({
      step: "identities",
      reason: "runtime_role_mismatch",
      detail: { expected_runtime_role: "runtime_role", actual_runtime_role: "other_runtime" },
    });

    const wrongOperator = makePorts({
      readOperatorIdentity: async () => "other_operator",
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(wrongOperator.ports))),
    ).toMatchObject({ step: "identities", reason: "operator_role_mismatch" });

    const runtimeIsMigrator = makePorts({
      readMigratorIdentity: async () => "runtime_role",
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(runtimeIsMigrator.ports))),
    ).toMatchObject({
      step: "identities",
      reason: "runtime_migrator_conflict",
      detail: { role: "runtime_role" },
    });

    const operatorIsRuntime = makePorts({
      readOperatorIdentity: async () => "runtime_role",
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(operatorIsRuntime.ports))),
    ).toMatchObject({ step: "identities", reason: "runtime_operator_conflict" });
  });

  test("refuses missing probe EXECUTE and any direct identity-table write", async () => {
    const missingExecute = makePorts({
      readPrivilegeMatrix: async () => ({
        runtime: {
          probe_execute: false,
          identity_insert: false,
          identity_update: false,
          identity_delete: false,
        },
        operator: {
          probe_execute: false,
          identity_insert: false,
          identity_update: false,
          identity_delete: false,
        },
      }),
    });
    const missingExecuteRefusal = await refusalOf(() =>
      runHnsStagingPostMigration(makeInput(missingExecute.ports)),
    );
    expect(missingExecuteRefusal).toMatchObject({
      step: "privilege_matrix",
      reason: "probe_execute_missing",
      detail: { role: "runtime_role" },
    });
    expect(missingExecute.events).not.toContain("stage");

    for (const identityKind of ["runtime", "operator"] as const) {
      const writeAllowed = makePorts({
        readPrivilegeMatrix: async () => ({
          runtime: {
            probe_execute: true,
            identity_insert: identityKind === "runtime",
            identity_update: false,
            identity_delete: false,
          },
          operator: {
            probe_execute: false,
            identity_insert: identityKind === "operator",
            identity_update: false,
            identity_delete: false,
          },
        }),
      });
      const refusal = await refusalOf(() =>
        runHnsStagingPostMigration(makeInput(writeAllowed.ports)),
      );
      expect(refusal).toMatchObject({
        step: "privilege_matrix",
        reason: "identity_write_allowed",
        detail: { identity_kind: identityKind, privilege: "INSERT" },
      });
      expect(writeAllowed.events).not.toContain("start");
    }
  });

  test("reports recorded probe failures by name after the service starts", async () => {
    for (const [reason, outcome] of [
      ["artifact_mismatch", "failed"],
      ["attempt_mismatch", "failed"],
      ["probe_absent", "probe_absent"],
      ["lease_conflict", "lease_conflict"],
    ] as const) {
      const { ports } = makePorts({
        readCutoverIdentity: async () =>
          identityRow({
            attempt_id: attemptId,
            probe_outcome: outcome,
            probe_reason: reason,
            probe_job_id: null,
            lease_fence: null,
            probe_completed_at: null,
            probe_fresh: false,
          }),
      });
      const refusal = await refusalOf(() => runHnsStagingPostMigration(makeInput(ports)));
      expect(refusal).toMatchObject({ step: "service_identity", reason });
      expect(refusal.service_disposition).toMatchObject({
        unit: HNS_STAGING_SERVICE_UNIT,
        disposition: "started_unverified",
        attempt_id: attemptId,
      });
      expect(refusal.recovery).toEqual({
        resumable: true,
        stop_service_before_rerun: true,
        attempt_id: attemptId,
      });
    }
  });

  test("reports a wrong running artifact and stale-attempt evidence", async () => {
    const wrongArtifact = makePorts({
      readCutoverIdentity: async () =>
        identityRow({ bundle_sha256: "b".repeat(64), measured_bundle_sha256: "b".repeat(64) }),
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(wrongArtifact.ports))),
    ).toMatchObject({ step: "service_identity", reason: "wrong_running_artifact" });

    const staleAttempt = makePorts({
      readCutoverIdentity: async () => identityRow({ attempt_id: "attempt-previous" }),
    });
    expect(
      await refusalOf(() => runHnsStagingPostMigration(makeInput(staleAttempt.ports))),
    ).toMatchObject({
      step: "service_identity",
      reason: "stale_attempt_result",
      detail: { expected_attempt_id: attemptId, actual_attempt_id: "attempt-previous" },
    });
  });

  test("refuses an absent service, absent progress and incompatible schema after start", async () => {
    const absent = makePorts({ readCutoverIdentity: async () => undefined });
    const absentRefusal = await refusalOf(() =>
      runHnsStagingPostMigration(makeInput(absent.ports)),
    );
    expect(absentRefusal).toMatchObject({
      step: "service_identity",
      reason: "service_never_started",
    });
    expect(absentRefusal.recovery).toMatchObject({
      resumable: true,
      stop_service_before_rerun: true,
    });

    let reads = 0;
    const missingProgress = makePorts({
      readCutoverIdentity: async () => {
        reads += 1;
        return reads === 1 ? identityRow() : undefined;
      },
    });
    const progressRefusal = await refusalOf(() =>
      runHnsStagingPostMigration(makeInput(missingProgress.ports)),
    );
    expect(progressRefusal).toMatchObject({
      step: "executor_progress",
      reason: "executor_progress_missing",
      detail: { probe_outcome: "absent" },
    });
    expect(progressRefusal.service_disposition).toMatchObject({
      disposition: "started_unverified",
    });

    const incompatible = makePorts({
      readSchemaCompatibility: async () => "incompatible",
    });
    const incompatibleRefusal = await refusalOf(() =>
      runHnsStagingPostMigration(makeInput(incompatible.ports)),
    );
    expect(incompatibleRefusal).toMatchObject({
      step: "schema_compatibility",
      reason: "schema_incompatible",
    });
    // The compatibility read is the first post-start verification, so no
    // identity poll or progress read can follow a refusal there.
    expect(incompatible.events).toContain("start");
    expect(incompatible.events).not.toContain("identity");
  });

  test("retries with a fresh attempt identifier after a refusal", async () => {
    const ids = ["attempt-first-0001", "attempt-second-0002"];
    let compatibilityCalls = 0;
    const { ports, staged } = makePorts({
      readSchemaCompatibility: async () => {
        compatibilityCalls += 1;
        return compatibilityCalls === 1 ? "incompatible" : "compatible";
      },
      readCutoverIdentity: async () =>
        identityRow({ attempt_id: staged.at(-1)?.attempt_id ?? ids[0] }),
    });
    const first = await refusalOf(() =>
      runHnsStagingPostMigration({ ...makeInput(ports), new_attempt_id: () => ids[0] }),
    );
    expect(first).toMatchObject({ step: "schema_compatibility" });
    const second = await runHnsStagingPostMigration({
      ...makeInput(ports),
      new_attempt_id: () => ids[1],
    });
    expect(second.attempt_id).toBe(ids[1]);
    expect(staged.map((entry) => entry.attempt_id)).toEqual([ids[0], ids[1]]);
  });

  test("a refusal carries the completed step results for a resumable receipt", async () => {
    const { ports: firstPorts } = makePorts();
    const first = await refusalOf(() =>
      runHnsStagingPostMigration({
        ...makeInput(firstPorts),
        authorized: {
          ...authorizedTarget,
          service_unit: "pirate-hns-authority-provisioner.service",
        },
      }),
    );
    expect(first.completed_results).toEqual([]);

    const { ports } = makePorts({
      readPrivilegeMatrix: async () => ({
        runtime: {
          probe_execute: false,
          identity_insert: false,
          identity_update: false,
          identity_delete: false,
        },
        operator: {
          probe_execute: false,
          identity_insert: false,
          identity_update: false,
          identity_delete: false,
        },
      }),
    });
    const partial = await refusalOf(() => runHnsStagingPostMigration(makeInput(ports)));
    const completed = partial.completed_results as readonly { step: string }[];
    expect(completed.map((entry) => entry.step)).toEqual([
      "target_and_ledger",
      "identities",
      "grants",
    ]);
    expect(completed[0]).toMatchObject({
      step: "target_and_ledger",
      result: { endpoint, applied_migrations: pinnedMigrations.length },
    });
  });

  test("the unhandled failure shape redacts credentials", () => {
    const json = postMigrationFailureJson(
      new Error("connect failed: postgres://operator:secret@staging.example:5432/postgres"),
    );
    expect(json).not.toContain("secret");
    expect(json).not.toContain("postgres://");
    expect(JSON.parse(json)).toMatchObject({ outcome: "post_migration_failed" });
  });

  test("the refusal JSON carries the named fields and not credentials", () => {
    const json = postMigrationRefusalJson({
      outcome: "post_migration_refused",
      step: "service_identity",
      reason: "wrong_running_artifact",
      detail: { expected_bundle_sha256: bundleSha },
      service_disposition: {
        unit: HNS_STAGING_SERVICE_UNIT,
        started: true,
        disposition: "started_unverified",
        attempt_id: attemptId,
      },
      recovery: { resumable: true, stop_service_before_rerun: true, attempt_id: attemptId },
    });
    expect(JSON.parse(json)).toEqual({
      outcome: "post_migration_refused",
      step: "service_identity",
      reason: "wrong_running_artifact",
      detail: { expected_bundle_sha256: bundleSha },
      service_disposition: {
        unit: HNS_STAGING_SERVICE_UNIT,
        started: true,
        disposition: "started_unverified",
        attempt_id: attemptId,
      },
      recovery: { resumable: true, stop_service_before_rerun: true, attempt_id: attemptId },
    });
    expect(json).not.toContain("postgres://");
  });
});
