import { describe, expect, test } from "bun:test";
import {
  assertMigrationsWithinEndpoint,
  type CutoverIdentityRow,
  cutoverRefusalJson,
  type HnsReadinessCutoverPorts,
  HnsReadinessCutoverRefused,
  pollCutoverIdentity,
  probeOutcomeRefusal,
  runHnsReadinessCutover,
} from "./hns-readiness-cutover.ts";

const compatibleService = "pirate-hns-authority-provisioner-v2";
const compatibleEnvelope = "hns-lifecycle-job-envelope-v1";
const executorId = "cutover-executor";
const bundleSha = "a".repeat(64);
const attemptId = "attempt-00000001";

function bundle(serviceVersion = compatibleService) {
  return {
    bundle_path: "/stage/source/pirate-hns-authority-provisioner.mjs",
    bundle_sha256: bundleSha,
    service_version: serviceVersion,
    job_envelope_version: compatibleEnvelope,
    executor_id: executorId,
    attempt_id: attemptId,
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
        attempt_id: attemptId,
        bundle_sha256: bundleSha,
        measured_bundle_sha256: bundleSha,
        expected_bundle_sha256: bundleSha,
        service_version: compatibleService,
        executor_id: executorId,
        probe_job_id: 7,
        lease_fence: 1,
        probe_completed_at: new Date(),
        probe_fresh: true,
        probe_outcome: "ready",
        probe_reason: null,
      };
    },
    verifyExecutorProgress: async () => {
      events.push("progress");
      return { probe_outcome: "ready", probe_reason: null, probe_fresh: true };
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
        attempt_id: attemptId,
        bundle_sha256: "b".repeat(64),
        measured_bundle_sha256: "b".repeat(64),
        expected_bundle_sha256: bundleSha,
        service_version: compatibleService,
        executor_id: executorId,
        probe_job_id: 7,
        lease_fence: 1,
        probe_completed_at: new Date(),
        probe_fresh: true,
        probe_outcome: "ready",
        probe_reason: null,
      }),
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: { step: "service_identity", reason: "wrong_running_artifact" },
    });
  });

  test("refuses a previous attempt's result for a fresh attempt", async () => {
    const { ports } = makePorts({
      verifyRunningIdentity: async () => ({
        attempt_id: "attempt-previous",
        bundle_sha256: bundleSha,
        measured_bundle_sha256: bundleSha,
        expected_bundle_sha256: bundleSha,
        service_version: compatibleService,
        executor_id: executorId,
        probe_job_id: 7,
        lease_fence: 1,
        probe_completed_at: new Date(),
        probe_fresh: true,
        probe_outcome: "ready",
        probe_reason: null,
      }),
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: { step: "service_identity", reason: "stale_attempt_result" },
    });
  });

  test("reports a recorded artifact mismatch by name without executor progress", async () => {
    const { ports, events } = makePorts({
      verifyRunningIdentity: async () => {
        events.push("identity");
        return {
          attempt_id: attemptId,
          bundle_sha256: bundleSha,
          measured_bundle_sha256: "b".repeat(64),
          expected_bundle_sha256: bundleSha,
          service_version: compatibleService,
          executor_id: executorId,
          probe_job_id: null,
          lease_fence: null,
          probe_completed_at: null,
          probe_fresh: false,
          probe_outcome: "failed",
          probe_reason: "artifact_mismatch",
        };
      },
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: {
        step: "service_identity",
        reason: "artifact_mismatch",
        detail: { probe_outcome: "failed", probe_reason: "artifact_mismatch" },
      },
    });
    expect(events).not.toContain("progress");
  });

  test("reports a recorded attempt mismatch by name without executor progress", async () => {
    const { ports, events } = makePorts({
      verifyRunningIdentity: async () => {
        events.push("identity");
        return {
          attempt_id: attemptId,
          bundle_sha256: bundleSha,
          measured_bundle_sha256: bundleSha,
          expected_bundle_sha256: bundleSha,
          service_version: compatibleService,
          executor_id: executorId,
          probe_job_id: null,
          lease_fence: null,
          probe_completed_at: null,
          probe_fresh: false,
          probe_outcome: "failed",
          probe_reason: "attempt_mismatch",
        };
      },
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: { step: "service_identity", reason: "attempt_mismatch" },
    });
    expect(events).not.toContain("progress");
  });

  test("reports an absent probe by name", async () => {
    const { ports } = makePorts({
      verifyRunningIdentity: async () => ({
        attempt_id: attemptId,
        bundle_sha256: bundleSha,
        measured_bundle_sha256: bundleSha,
        expected_bundle_sha256: bundleSha,
        service_version: compatibleService,
        executor_id: executorId,
        probe_job_id: null,
        lease_fence: null,
        probe_completed_at: null,
        probe_fresh: false,
        probe_outcome: "probe_absent",
        probe_reason: "probe job missing",
      }),
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: { step: "service_identity", reason: "probe_absent" },
    });
  });

  test("refuses compatible schema without executor progress", async () => {
    const { ports } = makePorts({
      verifyExecutorProgress: async () => ({
        probe_outcome: "failed",
        probe_reason: "artifact_mismatch",
        probe_fresh: true,
      }),
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({
      refusal: {
        step: "executor_progress",
        reason: "artifact_mismatch",
        detail: { probe_outcome: "failed", probe_reason: "artifact_mismatch" },
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

  test("probe outcomes map to immediate named refusals", () => {
    expect(probeOutcomeRefusal("failed", "artifact_mismatch")).toBe("artifact_mismatch");
    expect(probeOutcomeRefusal("failed", "attempt_mismatch")).toBe("attempt_mismatch");
    expect(probeOutcomeRefusal("failed", "something_else")).toBe("probe_failed");
    expect(probeOutcomeRefusal("probe_absent", "probe job missing")).toBe("probe_absent");
    expect(probeOutcomeRefusal("lease_conflict", "probe job is not claimable")).toBe(
      "lease_conflict",
    );
    expect(probeOutcomeRefusal("ready", null)).toBeNull();
    expect(probeOutcomeRefusal("replayed", null)).toBeNull();
  });
});

function identityRow(overrides: Partial<CutoverIdentityRow> = {}): CutoverIdentityRow {
  return {
    attempt_id: attemptId,
    bundle_sha256: bundleSha,
    measured_bundle_sha256: bundleSha,
    expected_bundle_sha256: bundleSha,
    service_version: compatibleService,
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

describe("HNS cutover identity polling", () => {
  function fakeClock(): Readonly<{
    now: () => number;
    sleep: (milliseconds: number) => Promise<void>;
    sleeps: () => number;
  }> {
    const state = { current: 0, sleeps: 0 };
    return {
      now: () => state.current,
      sleep: async (milliseconds: number) => {
        state.sleeps += 1;
        state.current += milliseconds;
      },
      sleeps: () => state.sleeps,
    };
  }

  test("returns a matching attempt's recorded failure immediately", async () => {
    const clock = fakeClock();
    const result = await pollCutoverIdentity({
      attempt_id: attemptId,
      read_identity: async () =>
        identityRow({
          probe_outcome: "failed",
          probe_reason: "artifact_mismatch",
          probe_job_id: null,
          lease_fence: null,
          probe_completed_at: null,
          probe_fresh: false,
        }),
      timeout_ms: 60_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toMatchObject({
      attempt_id: attemptId,
      probe_outcome: "failed",
      probe_reason: "artifact_mismatch",
      probe_job_id: null,
    });
    expect(clock.sleeps()).toBe(0);
  });

  test("waits past a stale attempt and returns this attempt's success", async () => {
    const clock = fakeClock();
    let reads = 0;
    const result = await pollCutoverIdentity({
      attempt_id: attemptId,
      read_identity: async () => {
        reads += 1;
        return reads === 1 ? identityRow({ attempt_id: "attempt-previous" }) : identityRow();
      },
      timeout_ms: 60_000,
      poll_interval_ms: 250,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toMatchObject({ attempt_id: attemptId, probe_outcome: "ready" });
    expect(clock.sleeps()).toBe(1);
  });

  test("surfaces stale-attempt evidence only at the bounded deadline", async () => {
    const clock = fakeClock();
    const result = await pollCutoverIdentity({
      attempt_id: attemptId,
      read_identity: async () => identityRow({ attempt_id: "attempt-previous" }),
      timeout_ms: 1_000,
      poll_interval_ms: 400,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toMatchObject({ attempt_id: "attempt-previous", probe_outcome: "ready" });
    expect(clock.sleeps()).toBeGreaterThan(0);
  });

  test("reports deadline exhaustion as absence", async () => {
    const clock = fakeClock();
    const result = await pollCutoverIdentity({
      attempt_id: attemptId,
      read_identity: async () => undefined,
      timeout_ms: 500,
      poll_interval_ms: 500,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toBeNull();
  });
});
