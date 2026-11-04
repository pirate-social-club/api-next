import { expect, mock, test } from "bun:test";
import {
  AlertCollector,
  ControlPlaneDb,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import type { MegapotRewardsJobOptions } from "./megapot-rewards.ts";
import { buildJobRegistry, JobContext } from "./registry.ts";
import {
  makeSerialStudyMegapotRecoveryJob,
  runSerialStudyMegapotRecovery,
} from "./serial-study-megapot-recovery.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeMegapotRewardsJob } = await import("./megapot-rewards.ts");
const { makeStudySpokenAnswerRecoveryJob } = await import("./study-spoken-answer-recovery.ts");
const { makeHnsRootHealthRenewalJob } = await import("./hns-root-health-renewal.ts");

const options: MegapotRewardsJobOptions = {
  environment: "staging",
  workerVersion: { id: "serial-test", tag: "", timestamp: "2026-10-14T00:00:00Z" },
  attestationId: "megapot-base-sepolia-v2",
  rpcUrl: "https://rpc.invalid/",
  custodyPrivateKey: `0x${"11".repeat(32)}`,
  gasTopupPrivateKey: null,
  commitmentBucket: {} as MegapotRewardsJobOptions["commitmentBucket"],
  commitmentPublicOrigin: "https://commitments.invalid",
  requiredConfirmations: 3,
  observationTtlMs: 300_000,
  approvedAllowanceAtomic: 1n,
  purchaseSafetyMarginSeconds: 120,
  gasLimitMultiplierBps: 12_000,
  nativeGasReserveFloorWei: 1n,
  externalSponsorDailyTicketCeiling: 1,
  externalSponsorDailySpendCeilingAtomic: 1n,
  sharedSponsorDailyTicketCeiling: 1,
  sharedSponsorDailySpendCeilingAtomic: 1n,
};
const bucket = {
  head: async () => null,
  delete: async () => {},
};

test("one serial writer owns the complete Account recovery/Megapot union alongside HNS", async () => {
  const study = makeStudySpokenAnswerRecoveryJob({}, bucket);
  const megapot = makeMegapotRewardsJob({}, options);
  // The registry still rejects the real conflicting standalone declarations.
  await expect(Effect.runPromise(buildJobRegistry([study, megapot]))).rejects.toMatchObject({
    reason: "duplicate-table-writer",
  });
  const joint = makeSerialStudyMegapotRecoveryJob({}, study, megapot);
  const hns = makeHnsRootHealthRenewalJob({});
  const registry = await Effect.runPromise(buildJobRegistry([joint, hns]));
  expect(registry.declarations).toEqual([joint, hns]);
  expect(joint.name).toBe(megapot.name);
  expect(joint.lane).toBe(megapot.lane);
  expect(joint.schedule).toBe(megapot.schedule);
  expect(joint.timeout).toBe(megapot.timeout);
  expect(new Set(joint.reads)).toEqual(new Set([...study.reads, ...megapot.reads]));
  expect(new Set(joint.writes)).toEqual(new Set([...study.writes, ...megapot.writes]));
  expect(joint.writes).not.toContain("postgres:guest_participation_operations");
  expect(joint.reads).not.toContain("postgres:guest_study_spoken_checkpoints");
  expect(joint.requiresAdapterSafety).toBe(true);
});

test("financial work waits for an outstanding Account recovery stage to settle", async () => {
  const trace: string[] = [];
  let release = () => {};
  let signalStarted = () => {};
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const outstanding = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = Effect.runPromise(
    runSerialStudyMegapotRecovery({
      study: Effect.promise(async () => {
        trace.push("account");
        signalStarted();
        await outstanding;
        trace.push("account-settled");
      }),
      financial: Effect.sync(() => {
        trace.push("financial");
      }),
      outerStartedAtMs: 1000,
      now: () => 2000,
    }),
  );
  try {
    await started;
    expect(trace).toEqual(["account"]);
  } finally {
    release();
  }
  expect(await running).toEqual({ financial: "ran", remainingMs: 49_000 });
  expect(trace).toEqual(["account", "account-settled", "financial"]);
});

test.each([
  [
    "recovery failure",
    new ControlPlaneStatementFailed({
      label: "account-spoken.recovery.closed-checkpoints",
      sqlState: null,
      constraint: null,
      outcomeCertainty: "completed",
    }),
  ],
  [
    "statement uncertainty",
    new ControlPlaneStatementFailed({
      label: "account-spoken.recovery.closed-checkpoints",
      sqlState: null,
      constraint: null,
      outcomeCertainty: "unknown",
    }),
  ],
  [
    "COMMIT uncertainty",
    new ControlPlaneTransactionOutcomeUnknown({
      phase: "commit",
      label: "account-spoken.recovery.closed-checkpoints",
      limitMs: 3000,
      elapsedMs: 3000,
    }),
  ],
] as const)(
  "actual Account %s stops the joint job before all financial setup and retries",
  async (_name, failure) => {
    let transactions = 0;
    let financialCalls = 0;
    const db: ControlPlaneDb["Service"] = {
      execute: () =>
        Effect.sync(() => {
          financialCalls++;
          throw new Error("Financial work must not start after recovery refusal");
        }),
      withTransaction: () =>
        Effect.sync(() => {
          transactions++;
        }).pipe(Effect.andThen(Effect.fail(failure))),
    };
    const study = makeStudySpokenAnswerRecoveryJob({}, bucket);
    const megapot = makeMegapotRewardsJob(
      {},
      {
        ...options,
        boundedControlPlane: Layer.succeed(ControlPlaneDb, db),
      },
    );
    const joint = makeSerialStudyMegapotRecoveryJob({}, study, megapot);
    const result = await Effect.runPromise(
      Effect.flip(
        joint.run.pipe(
          Effect.retry({ schedule: joint.retry, while: () => true }),
          Effect.provideService(ControlPlaneDb, db),
          Effect.provideService(AlertCollector, { emit: () => Effect.void }),
          Effect.provideService(JobContext, {
            owner: "serial-test",
            attemptId: "serial-attempt",
            startedAtMs: Date.now(),
            lease: () => ({ owner: "serial-test", generation: 1, expiresAt: Date.now() + 60_000 }),
            adapterSafety: { isProven: () => false, markAbortedOrFenced: () => {} },
          }),
        ),
      ),
    );
    expect(result).toBe(failure);
    expect(transactions).toBe(1);
    expect(financialCalls).toBe(0);
  },
);

test("recovery consumes the original financial budget rather than resetting it", async () => {
  let now = 31_000;
  let financialCalls = 0;
  const result = await Effect.runPromise(
    runSerialStudyMegapotRecovery({
      study: Effect.sync(() => {
        now = 39_000;
      }),
      financial: Effect.sync(() => {
        financialCalls++;
      }),
      outerStartedAtMs: 1000,
      now: () => now,
    }),
  );
  expect(result).toEqual({ financial: "skipped_remaining_budget", remainingMs: 12_000 });
  expect(financialCalls).toBe(0);
});

test("a missing or backward original clock refuses before either source runs", async () => {
  let calls = 0;
  for (const outerStartedAtMs of [Number.NaN, 3000]) {
    const work = Effect.sync(() => {
      calls++;
    });
    await expect(
      Effect.runPromise(
        runSerialStudyMegapotRecovery({
          study: work,
          financial: work,
          outerStartedAtMs,
          now: () => 2000,
        }),
      ),
    ).rejects.toBeDefined();
  }
  expect(calls).toBe(0);
});
