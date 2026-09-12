import { describe, expect, test } from "bun:test";
import {
  cutoverRefusalJson,
  type HnsReadinessCutoverPorts,
  HnsReadinessCutoverRefused,
  runHnsReadinessCutover,
} from "./hns-readiness-cutover.ts";

const compatibleService = "pirate-hns-authority-provisioner-v2";
const compatibleEnvelope = "hns-lifecycle-job-envelope-v1";

function bundle(serviceVersion = compatibleService) {
  return {
    bundle_path: "/stage/source/pirate-hns-authority-provisioner.mjs",
    bundle_sha256: "a".repeat(64),
    service_version: serviceVersion,
    job_envelope_version: compatibleEnvelope,
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
    startService: async () => {
      events.push("start");
    },
    verifyClaims: async () => {
      events.push("verify");
      return true;
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
      "start",
      "verify",
    ]);
    expect(steps).toEqual([
      "bundle_staged",
      "executor_quiesced",
      "leases_accounted",
      "preflight_applied",
      "removal_applied",
      "service_started",
      "claims_verified",
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

  test("refuses unverified claims after starting the service", async () => {
    const { ports, events } = makePorts({
      verifyClaims: async () => {
        events.push("verify");
        return false;
      },
    });
    await expect(
      runHnsReadinessCutover({ bundle: bundle(), stage_directory: "/stage/current", ports }),
    ).rejects.toMatchObject({ refusal: { step: "verify_claims", reason: "claims_unverified" } });
    expect(events).toEqual([
      "read_schema",
      "stage",
      "quiesce",
      "leases",
      "preflight",
      "removal",
      "start",
      "verify",
    ]);
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
