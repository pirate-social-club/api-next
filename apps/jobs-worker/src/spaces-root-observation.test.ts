import { describe, expect, test } from "bun:test";
import type { SpacesRootObservationInputV1 } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import type { SpacesRootAuthorityObserver } from "@pirate/platform-cf/spaces-owner-proof-repository";
import type { SpacesRootObservationTargets } from "@pirate/platform-cf/spaces-root-observation-targets";
import { Effect } from "effect";
import { JobContext } from "./registry.ts";
import { makeSpacesRootObservationJob } from "./spaces-root-observation.ts";

type Verified = Extract<
  Awaited<ReturnType<SpacesRootAuthorityObserver["observe"]>>,
  { kind: "verified" }
>;
const address = "bcs1poperatorfixture";
const script = `5120${"ab".repeat(32)}`;
const observedAt = "2026-09-27T04:00:00.000Z";
const target = { canonicalRoot: "yahoo", delegationAddress: address, delegationScript: script };
const sink: AlertSink = {
  log: () => undefined,
  delivery: { markSent: () => Effect.succeed(true), compensate: () => Effect.void },
};

const verified = (changes: Partial<Verified["evidence"]> = {}): Verified => ({
  kind: "verified",
  bytes: new Uint8Array([1]),
  evidence: {
    contract: "spaces-verifier-root-authority-v1",
    network: "mainnet",
    root: "@yahoo",
    outpoint: `${"11".repeat(32)}:1`,
    owner_script_pubkey_hex: `5120${"22".repeat(32)}`,
    owner_xonly_key_hex: "22".repeat(32),
    tip_height: 968760,
    tip_time: 1_790_000_000,
    tip_age_seconds: 20,
    anchor_height: 968760,
    anchor_block_hash: "33".repeat(32),
    operator_num_id: "num1exampleoperator",
    operator_num_live: true,
    operator_num_outpoint: `${"44".repeat(32)}:0`,
    operator_num_holder_script_pubkey_hex: script,
    reverse_delegation_matches: true,
    latest_commitment: null,
    latest_final_commitment: null,
    commitment_count: 0,
    root_certificate_sha256_hex: "55".repeat(32),
    root_certificate_base64: "Y2VydA==",
    owner_signature_verified: null,
    anchor_bound_outpoint: true,
    proof_anchor_height: 968760,
    proof_anchor_block_hash: "33".repeat(32),
    proof_root_anchor_id_hex: "66".repeat(32),
    certificate_anchor_height: 968760,
    certificate_anchor_block_hash: "33".repeat(32),
    certificate_root_anchor_id_hex: "66".repeat(32),
    chain_proof_sha256_hex: "77".repeat(32),
    chain_proof_base64: "cHJvb2Y=",
    ...changes,
  },
});

const runWith = async (observe: SpacesRootAuthorityObserver["observe"]) => {
  const recorded: SpacesRootObservationInputV1[] = [];
  const targets: SpacesRootObservationTargets = {
    list: () => Effect.succeed([target]),
    databaseNow: () => Effect.succeed(observedAt),
  };
  const job = makeSpacesRootObservationJob(
    sink,
    targets,
    { observe },
    {
      recordRootObservation: (input) =>
        Effect.sync(() => {
          recorded.push(input);
          return {
            kind: "recorded" as const,
            observation_generation: recorded.length,
            drift: null,
            suspended: null,
          };
        }),
    },
  );
  await Effect.runPromise(
    job.run.pipe(
      Effect.provideService(JobContext, {
        adapterSafety: { isProven: () => true, markAbortedOrFenced: () => undefined },
        attemptId: "test-root-observation",
        lease: () => ({ expiresAt: Date.now() + 120_000, generation: 1, owner: "test" }),
        owner: "test",
      }),
    ),
  );
  return { job, recorded };
};

describe("Spaces root observation job", () => {
  test("records a delegated root with a bounded verified zero-commitment history", async () => {
    const { job, recorded } = await runWith(async () => verified());
    expect(job.name).toBe("spaces-native.root-observation");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.root).toEqual({
      kind: "resolved",
      outpoint: `${"11".repeat(32)}:1`,
      key: "22".repeat(32),
      anchoredAt: observedAt,
      anchorCoversRootOutpoint: true,
      publication: "verified",
      delegationAddress: address,
    });
    expect(recorded[0]?.commitmentHistory).toEqual({
      kind: "verified",
      commitmentCount: 0,
      latestCommitmentRootHex: null,
    });
    expect(recorded[0]?.freshness.observation_max_age_ms).toBe(180_000);
  });

  test("records a changed or missing num as unassigned, never as the configured operator", async () => {
    for (const changes of [
      { operator_num_holder_script_pubkey_hex: `5120${"cd".repeat(32)}` },
      {
        operator_num_live: false,
        operator_num_holder_script_pubkey_hex: null,
        operator_num_outpoint: null,
      },
    ]) {
      const { recorded } = await runWith(async () => verified(changes));
      expect(recorded[0]?.root).toMatchObject({ delegationAddress: null });
    }
  });

  test("preserves a checked nonzero commitment root and refuses a missing history", async () => {
    const current = verified({
      commitment_count: 1,
      latest_commitment: { state_root: "ee".repeat(32), block_height: 968750 },
    });
    expect((await runWith(async () => current)).recorded[0]?.commitmentHistory).toEqual({
      kind: "verified",
      commitmentCount: 1,
      latestCommitmentRootHex: "ee".repeat(32),
    });
    expect((await runWith(async () => verified({ commitment_count: 1 }))).recorded).toEqual([]);
  });

  test("a pending anchor, unavailable verifier, or rejected stale evidence writes nothing", async () => {
    expect((await runWith(async () => ({ kind: "pending" }))).recorded).toEqual([]);
    expect(
      (
        await runWith(async () => {
          throw new Error("verifier unavailable");
        })
      ).recorded,
    ).toEqual([]);
    expect(
      (
        await runWith(async () => {
          throw new Error("stale proof anchor");
        })
      ).recorded,
    ).toEqual([]);
  });
});
