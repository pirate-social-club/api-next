import { expect, test } from "bun:test";
import {
  HNS_AUTHORITY_SUCCESSOR_CANDIDATE_VERSION,
  type prepareHnsAuthoritySuccessorCandidateV1,
} from "@pirate/application/hns-host-persistence";
import {
  HNS_AUTHORITY_SUCCESSOR_EMISSION_INPUT_VERSION,
  type HnsAuthoritySuccessorEmissionInputV1,
  HnsAuthoritySuccessorEmitterError,
  type HnsAuthoritySuccessorEmitterIoV1,
  runHnsAuthoritySuccessorEmitterV1,
} from "./authority-successor-emitter.ts";

const encoder = new TextEncoder();
const candidateBytes = encoder.encode('{"candidate":"review-exact"}');
const chainDs = [
  [10875, 13, 2, "a".repeat(64)],
  [10875, 13, 4, "b".repeat(96)],
] as const;

function emissionInput(): HnsAuthoritySuccessorEmissionInputV1 {
  const view = (authorityAddress: string) => ({
    authority_address: authorityAddress,
    outcome: "observed" as const,
    zone_bytes_digest: "c".repeat(64),
    dnskey_key_tag: 10875,
    derived_ds: chainDs,
  });
  return {
    version: HNS_AUTHORITY_SUCCESSOR_EMISSION_INPUT_VERSION,
    source_commit: "1".repeat(40),
    root_label: "jazleeuw",
    observed_at: "2026-08-29T17:00:00.000Z",
    chain_height: 344_448,
    generation_snapshot: {
      dns_current_generation: 5,
      app_host_current_generation: 9,
      successor_dns_latest_health_generation: 0,
    },
    expected_authority_addresses: ["94.103.168.161", "81.15.150.159"],
    authority_views: [view("94.103.168.161"), view("81.15.150.159")],
    chain_ds: chainDs,
    artifact_paths: {
      authority_inventory: "/evidence/authority-inventory.json",
      dns_zone_activation: "/evidence/dns-zone-activation.json",
      app_host_activation: "/evidence/app-host-activation.json",
      health_observation: "/evidence/health-observation.json",
      observer_evidence: "/evidence/observer-evidence.json",
    },
  };
}

type CandidatePreparer = typeof prepareHnsAuthoritySuccessorCandidateV1;

function fakePreparer(calls: Parameters<CandidatePreparer>[0][]): CandidatePreparer {
  return async (input) => {
    const [firstView, secondView] = input.authority_views;
    if (firstView === undefined || secondView === undefined)
      throw new Error("incomplete test views");
    calls.push(input);
    return {
      candidate: {
        version: HNS_AUTHORITY_SUCCESSOR_CANDIDATE_VERSION,
        source_commit: input.source_commit,
        root_label: input.root_label,
        observed_at: input.observed_at,
        chain_height: input.chain_height,
        generations: {
          dns_activation_generation: 6,
          app_host_activation_generation: 10,
          health_generation: 1,
        },
        dnskey_key_tag: 10875,
        authority_views: [firstView, secondView],
        chain_ds: input.chain_ds,
        artifacts: [],
      },
      candidate_bytes: candidateBytes,
      candidate_sha256: "d".repeat(64),
    };
  };
}

function memoryIo(
  input: HnsAuthoritySuccessorEmissionInputV1,
  overrides: Readonly<Record<string, Uint8Array>> = {},
) {
  const inputPath = "/evidence/emission-input.json";
  const files = new Map<string, Uint8Array>([
    [inputPath, encoder.encode(JSON.stringify(input))],
    ...Object.values(input.artifact_paths).map(
      (path, index) => [path, encoder.encode(`artifact-${index}`)] as const,
    ),
    ...Object.entries(overrides),
  ]);
  const reads: Array<readonly [string, number]> = [];
  const emissions: Uint8Array[] = [];
  const io: HnsAuthoritySuccessorEmitterIoV1 = {
    read: async (path, maximumBytes) => {
      reads.push([path, maximumBytes]);
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error("unavailable");
      return new Uint8Array(bytes);
    },
    emit: async (bytes) => {
      emissions.push(new Uint8Array(bytes));
    },
  };
  return { inputPath, files, reads, emissions, io };
}

test("reads only explicit absolute evidence paths and emits exact candidate bytes once", async () => {
  const input = emissionInput();
  const harness = memoryIo(input);
  const preparationCalls: Parameters<CandidatePreparer>[0][] = [];

  const result = await runHnsAuthoritySuccessorEmitterV1(
    ["--input", harness.inputPath],
    harness.io,
    fakePreparer(preparationCalls),
  );

  expect(harness.reads).toEqual([
    [harness.inputPath, 65_536],
    ...Object.values(input.artifact_paths).map((path) => [path, 4 * 1_024 * 1_024] as const),
  ]);
  expect(preparationCalls).toHaveLength(1);
  expect(Object.keys(preparationCalls[0]?.artifacts ?? {})).toEqual(
    Object.keys(input.artifact_paths),
  );
  expect(harness.emissions).toEqual([candidateBytes]);
  expect(result.candidate_bytes).toEqual(candidateBytes);
});

test("requires one explicit absolute input and canonical input bytes", async () => {
  const input = emissionInput();
  const harness = memoryIo(input);
  const preparationCalls: Parameters<CandidatePreparer>[0][] = [];
  const prepare = fakePreparer(preparationCalls);

  await expect(runHnsAuthoritySuccessorEmitterV1([], harness.io, prepare)).rejects.toMatchObject({
    reason: "invalid_arguments",
  });
  await expect(
    runHnsAuthoritySuccessorEmitterV1(["--input", "relative.json"], harness.io, prepare),
  ).rejects.toMatchObject({ reason: "invalid_arguments" });

  harness.files.set(harness.inputPath, encoder.encode(JSON.stringify(input, null, 2)));
  await expect(
    runHnsAuthoritySuccessorEmitterV1(["--input", harness.inputPath], harness.io, prepare),
  ).rejects.toMatchObject({ reason: "invalid_input_document" });
  expect(preparationCalls).toHaveLength(0);
  expect(harness.emissions).toHaveLength(0);
});

test("rejects relative, duplicate, missing, and oversized artifact paths without emission", async () => {
  const cases = [
    {
      label: "relative",
      patch: { dns_zone_activation: "relative.json" },
      reason: "invalid_input_document",
    },
    {
      label: "duplicate",
      patch: { dns_zone_activation: "/evidence/authority-inventory.json" },
      reason: "invalid_input_document",
    },
    {
      label: "missing",
      patch: { dns_zone_activation: "/evidence/missing.json" },
      reason: "artifact_read_failed",
    },
  ] as const;

  for (const scenario of cases) {
    const base = emissionInput();
    const input = {
      ...base,
      artifact_paths: { ...base.artifact_paths, ...scenario.patch },
    };
    const harness = memoryIo(input);
    if (scenario.label === "missing") {
      harness.files.delete(input.artifact_paths.dns_zone_activation);
    }
    const calls: Parameters<CandidatePreparer>[0][] = [];
    await expect(
      runHnsAuthoritySuccessorEmitterV1(
        ["--input", harness.inputPath],
        harness.io,
        fakePreparer(calls),
      ),
      scenario.label,
    ).rejects.toMatchObject({ reason: scenario.reason });
    expect(calls).toHaveLength(0);
    expect(harness.emissions).toHaveLength(0);
  }

  const input = emissionInput();
  const oversized = new Uint8Array(4 * 1_024 * 1_024 + 1);
  const harness = memoryIo(input, { [input.artifact_paths.authority_inventory]: oversized });
  await expect(
    runHnsAuthoritySuccessorEmitterV1(["--input", harness.inputPath], harness.io, fakePreparer([])),
  ).rejects.toMatchObject({ reason: "artifact_too_large" });
  expect(harness.emissions).toHaveLength(0);
});

test("never emits partial output when candidate preparation refuses", async () => {
  const input = emissionInput();
  const harness = memoryIo(input);
  const prepare: CandidatePreparer = async () => {
    throw new HnsAuthoritySuccessorEmitterError("invalid_input_document");
  };

  await expect(
    runHnsAuthoritySuccessorEmitterV1(["--input", harness.inputPath], harness.io, prepare),
  ).rejects.toThrow("invalid_input_document");
  expect(harness.emissions).toHaveLength(0);
});
