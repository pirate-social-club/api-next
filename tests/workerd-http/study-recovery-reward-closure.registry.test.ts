import { Effect } from "effect";
import { describe, expect, test } from "vitest";
import {
  type MegapotRewardsJobOptions,
  makeMegapotRewardsJob,
} from "../../apps/jobs-worker/src/megapot-rewards.ts";
import {
  buildJobRegistry,
  RegistryConfigurationError,
} from "../../apps/jobs-worker/src/registry.ts";
import { makeSerialStudyMegapotRecoveryJob } from "../../apps/jobs-worker/src/serial-study-megapot-recovery.ts";
import { makeStudySpokenAnswerRecoveryJob } from "../../apps/jobs-worker/src/study-spoken-answer-recovery.ts";

// Use genuine modules under the maintained Workerd pool, without module mocks.
// Only declaration factories and the real registry execute. No job.run,
// database, RPC, provider, R2 or signer executes.

const fixture = () => {
  let storageCalls = 0;
  const forbiddenStorage = async (): Promise<never> => {
    storageCalls++;
    throw new Error("declaration-only fixture must not perform storage I/O");
  };
  const bucket = { delete: forbiddenStorage, head: forbiddenStorage };
  const options: MegapotRewardsJobOptions = {
    environment: "test",
    workerVersion: { id: "registry-only", tag: "", timestamp: "2026-10-13T00:00:00.000Z" },
    attestationId: "registry-only-unadmitted",
    rpcUrl: "https://rpc.invalid",
    custodyPrivateKey: "unconfigured-registry-only-do-not-execute",
    gasTopupPrivateKey: null,
    commitmentBucket: { get: forbiddenStorage, put: forbiddenStorage },
    commitmentPublicOrigin: "https://commitments.invalid",
    requiredConfirmations: 3,
    observationTtlMs: 300_000,
    approvedAllowanceAtomic: 0n,
    purchaseSafetyMarginSeconds: 60,
    gasLimitMultiplierBps: 12_000,
    nativeGasReserveFloorWei: 0n,
    externalSponsorDailyTicketCeiling: 0,
    externalSponsorDailySpendCeilingAtomic: 0n,
    sharedSponsorDailyTicketCeiling: 0,
    sharedSponsorDailySpendCeilingAtomic: 0n,
  };
  const study = makeStudySpokenAnswerRecoveryJob({}, bucket);
  const megapot = makeMegapotRewardsJob({}, options);
  return { study, megapot, bucket, storageCalls: () => storageCalls };
};

const existingProjectionWrites = [
  "postgres:decision_records",
  "postgres:reward_eligibility_decisions",
  "postgres:megapot_pool_shares",
  "postgres:reward_subject_consumptions",
  "postgres:song_reward_bundle_claims",
  "postgres:song_reward_bundle_claim_legs",
  "postgres:song_reward_offer_legs",
  "postgres:reward_ledger_credits",
] as const;

const conditionalReadClosure = [
  "postgres:song_reward_offers",
  "postgres:song_reward_offer_legs",
  "postgres:megapot_pool_drawings",
  "postgres:policy_versions",
  "postgres:megapot_pool_shares",
  "postgres:reward_eligibility_decisions",
  "postgres:song_reward_bundle_claims",
  "postgres:song_reward_bundle_claim_legs",
  "postgres:reward_ledger_credits",
  "postgres:reward_subject_consumptions",
  "postgres:subject_keys",
  "postgres:active_subject_key_bindings",
  "postgres:assertion_bindings",
  "postgres:assertions",
  "postgres:evidence_receipts",
  "postgres:proof_sessions",
  "postgres:assertion_revalidation_events",
  "postgres:reward_uniqueness_authorities",
  "postgres:reward_asset_whitelist",
  "postgres:age_verification_ceremony_attempts",
  "postgres:age_verification_requirement_states",
  "postgres:account_age_verification_current",
] as const;

describe("actual Study recovery qualification closure registry admission", () => {
  test("the one actual serial source declaration owns the complete union and arbitrary duplicates still refuse", async () => {
    const f = fixture();
    const joint = makeSerialStudyMegapotRecoveryJob({}, f.study, f.megapot);
    const registry = await Effect.runPromise(buildJobRegistry([joint]));
    expect(registry.declarations).toEqual([joint]);
    expect(joint.name).toBe(f.megapot.name);
    expect(joint.lane).toBe(f.megapot.lane);
    expect(joint.schedule).toBe(f.megapot.schedule);
    expect(joint.timeout).toBe("50 seconds");
    expect(joint.reads).toEqual([...new Set([...f.study.reads, ...f.megapot.reads])]);
    expect(joint.writes).toEqual([...new Set([...f.study.writes, ...f.megapot.writes])]);
    for (const key of [
      "postgres:megapot_owner_snapshot_leaves",
      "postgres:megapot_owner_allocations",
      "postgres:reward_credit_persona_bindings",
    ])
      expect(joint.writes).toContain(key);
    const error = await Effect.runPromise(Effect.flip(buildJobRegistry([joint, f.study])));
    expect(error).toBeInstanceOf(RegistryConfigurationError);
    expect(error).toMatchObject({ reason: "duplicate-table-writer" });
    expect(f.storageCalls()).toBe(0);
  });

  test("each genuine job declaration admits alone without executing a job or storage", async () => {
    const f = fixture();
    for (const job of [f.study, f.megapot]) {
      const registry = await Effect.runPromise(buildJobRegistry([job]));
      expect(registry.declarations).toEqual([job]);
      expect(registry.byName.get(job.name)).toBe(job);
    }
    expect(f.study.name).toBe("study-spoken-answer.recover-expired");
    expect(f.megapot.name).toBe("megapot-rewards.cycle");
    expect(f.storageCalls()).toBe(0);
  });

  test("the actual Study declaration retains conditional Account trigger and authorization closure", () => {
    const f = fixture();
    for (const table of existingProjectionWrites) expect(f.study.writes).toContain(table);
    for (const table of conditionalReadClosure) expect(f.study.reads).toContain(table);
    expect(new Set(f.study.reads).size).toBe(f.study.reads.length);
    expect(new Set(f.study.writes).size).toBe(f.study.writes.length);
    expect(f.storageCalls()).toBe(0);
  });

  test("both genuine declaration orders refuse their actual shared writer ownership", async () => {
    const f = fixture();
    expect(f.study.writes.filter((key) => f.megapot.writes.includes(key)).sort()).toEqual([
      "postgres:reward_ledger_credits",
      "postgres:song_reward_offer_legs",
    ]);
    for (const declarations of [
      [f.megapot, f.study],
      [f.study, f.megapot],
    ]) {
      const error = await Effect.runPromise(Effect.flip(buildJobRegistry(declarations)));
      expect(error).toBeInstanceOf(RegistryConfigurationError);
      expect(error).toMatchObject({
        reason: "duplicate-table-writer",
        key: "postgres:song_reward_offer_legs",
      });
    }
    // The two actual lanes differ; moving lanes does not waive writer ownership.
    expect(f.study.lane === f.megapot.lane).toBe(false);
    expect(f.storageCalls()).toBe(0);
  });

  test("explicit private Guest metadata retains the same Account conflict without invoking its composer", async () => {
    const f = fixture();
    let guestCompositionCalls = 0;
    const withGuest = makeStudySpokenAnswerRecoveryJob({}, f.bucket, () => {
      guestCompositionCalls++;
      throw new Error("declaration-only fixture must not compose or execute Guest stages");
    });
    const guestOnlyWrites = withGuest.writes.filter((key) => !f.study.writes.includes(key));
    expect(guestOnlyWrites).toEqual([
      "postgres:guest_participation_operations",
      "postgres:guest_resource_edge_locks",
      "postgres:guest_resource_session_reservations",
      "postgres:guest_resource_release_receipts",
      "postgres:learner_audio_upload_attempts",
      "postgres:learner_audio_upload_cleanup_commands",
    ]);
    expect(withGuest.reads).toContain("postgres:guest_resource_provider_calls");
    expect(guestOnlyWrites).not.toContain("postgres:guest_resource_provider_calls");
    const solo = await Effect.runPromise(buildJobRegistry([withGuest]));
    expect(solo.byName.get(withGuest.name)).toBe(withGuest);
    const error = await Effect.runPromise(Effect.flip(buildJobRegistry([f.megapot, withGuest])));
    expect(error).toMatchObject({
      reason: "duplicate-table-writer",
      key: "postgres:song_reward_offer_legs",
    });
    expect(guestCompositionCalls).toBe(0);
    expect(f.storageCalls()).toBe(0);
  });
});
