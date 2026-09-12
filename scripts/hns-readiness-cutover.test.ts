import { describe, expect, test } from "bun:test";
import {
  assertMigrationsWithinEndpoint,
  cutoverRefusalJson,
  type HnsReadinessCutoverPorts,
  HnsReadinessCutoverRefused,
  runHnsReadinessCutover,
} from "./hns-readiness-cutover.ts";

const compatibleService = "pirate-hns-authority-provisioner-v2";
const compatibleEnvelope = "hns-lifecycle-job-envelope-v1";
const executorId = "cutover-executor";
const bundleSha = "a".repeat(64);

function bundle(serviceVersion = compatibleService) {
  return {
    bundle_path: "/stage/source/pirate-hns-authority-provisioner.mjs",
    bundle_sha256: bundleSha,
    service_version: serviceVersion,
    job_envelope_version: compatibleEnvelope,
    executor_id: executorId,
  };
}

function makePorts(overrides: Partial<HnsReadinessCutoverPorts> = {}): {
  readonly ports: HnsReadinessCutoverPorts;
  readonly events: string[];
} {
  const events: string[] = [];
  const ports: HnsReadinessCutoverPorts = {
    readSchemaState: async () => {
      events.push("read_schema");
      return {
        cutover_version: "0169",
        compatible_service_versions: [compatibleService],
        compatible_job_envelope_versions: [compatibleEnvelope],
      };
    },
    stageBundle: async () => {
      events.push("stage");
    },
    quiesceExecutor: async () => {
      events.push("quiesce");
    },
    accountLiveLegacyLeases: async () => {
      events.push("leases");
      return 0;
    },
    applyPreflight: async () => {
      events.push("preflight");
    },
    applyRemoval: async () => {
      events.push("removal");
    },
    seedExecutionProbe: async () => {
      events.push("seed_probe");
    },
    startService: async () => {
      events.push("start");
    },
    readSchemaCompatibility: async () => {
      events.push("compatibility");
      return "compatible";
    },
    verifyRunningIdentity: async () => {
      events.push("identity");
      return {
        bundle_sha256: bundleSha,
        service_version: compatibleService,
        executor_id: executorId,
        heartbeat_fresh: true,
      };
    },
    verifyExecutorProgress: async () => {
      events.push("progress");
      return { probe_outcome: "ready", heartbeat_fresh: true };
    },
    ...overrides,
  };
  return { ports, events };
}

describe("HNS readiness cutover sequence", () => {
  test("runs the compatible pair through the fixed order", async () => {
    const { ports, events } = makePorts();
    const steps = await runHnsReadinessCutover({
      bundle: bundle(),
      stage_directory: "/stage/current",
      ports,
    });
    expect(events).toEqual([
      "read_schema",
      "stage",
      "quiesce",
      "leases",
      "preflight",
      "removal",
      "seed_probe",
      "start",
      "compatibility",
      "identity",
      "progress",
    ]);
    expect(steps).toEqual([
      "bundle_staged",
      "executor_quiesced",
      "leases_accounted",
      "preflight_applied",
      "removal_applied",
      "probe_seeded",
      "service_started",
      "schema_compatibility_recorded",
      "service_identity_verified",
      "executor_progress_verified",
    ]);
  });

  test("refuses an unsupported old bundle before staging or quiescing", async () => {
    const { ports, events } = makePorts();
    const failure = runHnsReadinessCutover({
      bundle: bundle("pirate-hns-authority-provisioner-v1"),
      stage_directory: "/stage/current",
      ports,
    });
    await expect(failure).rejects.toBeInstanceOf(HnsReadinessCutoverRefused);
    await failure.catch((error: unknown) => {
      expect((error as HnsReadinessCutoverRefused).refusal).toMatchObject({
        step: "launch_guard",
        reason: "schema_incompatible",
      });
    });
    expect(events).toEqual(["read_schema"]);
  });

  test("refuses a live legacy lease after quiescing and before the removal", async () => {
    const { ports, events } = makePorts({
      accountLiveLegacyLeases: async () => {
        events.push("leases");
        return 2;
      },
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: {
        step: "account_leases",
        reason: "live_legacy_lease",
        detail: { live_legacy_leases: 2 },
      },
    });
    expect(events).toEqual(["read_schema", "stage", "quiesce", "leases"]);
  });

  test("refuses when the service never starts", async () => {
    const { ports, events } = makePorts({ verifyRunningIdentity: async () => null });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: { step: "service_identity", reason: "service_never_started" },
    });
    expect(events).toContain("start");
  });

  test("refuses a wrong running artifact", async () => {
    const { ports } = makePorts({
      verifyRunningIdentity: async () => ({
        bundle_sha256: "b".repeat(64),
        service_version: compatibleService,
        executor_id: executorId,
        heartbeat_fresh: true,
      }),
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: { step: "service_identity", reason: "wrong_running_artifact" },
    });
  });

  test("refuses compatible schema without executor progress", async () => {
    const { ports } = makePorts({
      verifyExecutorProgress: async () => ({ probe_outcome: "failed", heartbeat_fresh: true }),
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: {
        step: "executor_progress",
        reason: "executor_progress_missing",
        detail: { probe_outcome: "failed" },
      },
    });
  });

  test("refuses migrations beyond the reviewed cutover endpoint", () => {
    expect(() =>
      assertMigrationsWithinEndpoint([
        { version: "0168_hns_readiness_cutover_preflight.sql" },
        { version: "0169_hns_single_owner_readiness_cutover.sql" },
        { version: "0170_hns_renewal_authoritative_evidence.sql" },
        { version: "0171_hns_cutover_execution_probe.sql" },
      ]),
    ).not.toThrow();
    expect(() =>
      assertMigrationsWithinEndpoint([
        { version: "0171_hns_cutover_execution_probe.sql" },
        { version: "0172_unrelated_followup.sql" },
      ]),
    ).toThrow(HnsReadinessCutoverRefused);
    try {
      assertMigrationsWithinEndpoint([{ version: "0172_unrelated_followup.sql" }]);
    } catch (error) {
      expect((error as HnsReadinessCutoverRefused).refusal).toMatchObject({
        step: "migrations",
        reason: "migration_endpoint_exceeded",
        detail: { first_beyond: "0172_unrelated_followup.sql" },
      });
    }
  });

  test("the refusal JSON carries only the named fields", () => {
    const json = cutoverRefusalJson({
      outcome: "cutover_refused",
      step: "launch_guard",
      reason: "schema_incompatible",
      detail: { missing: "service_version" },
    });
    expect(JSON.parse(json)).toEqual({
      outcome: "cutover_refused",
      step: "launch_guard",
      reason: "schema_incompatible",
      detail: { missing: "service_version" },
    });
  });
});
