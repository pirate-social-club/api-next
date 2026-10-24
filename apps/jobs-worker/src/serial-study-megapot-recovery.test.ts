import { expect, mock, test } from "bun:test";
import {
  AlertCollector,
  ControlPlaneDb,
  ControlPlaneStatementFailed,
  ControlPlaneTransactionOutcomeUnknown,
} from "@pirate/application";
import { Effect, Layer } from "effect";
import type { MegapotRewardsJobOptions } from "./megapot-rewards.ts";
import { buildJobRegistry, JobContext, SONG_FUNDING_RECOVERY_WRITES } from "./registry.ts";
import {
  makeSerialStudyMegapotRecoveryJob,
  runSerialStudyMegapotRecovery,
} from "./serial-study-megapot-recovery.ts";
import { makeSongMegapotFundingRecoveryJob } from "./song-megapot-funding-recovery.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeMegapotRewardsJob } = await import("./megapot-rewards.ts");
const { makeStudySpokenAnswerRecoveryJob } = await import("./study-spoken-answer-recovery.ts");
const { makeHnsRootHealthRenewalJob } = await import("./hns-root-health-renewal.ts");
const { makeJobsWorkerDeclarations } = await import("./index.ts");
const { makeSafePoolPilotJob } = await import("./safe-pool-pilot.ts");

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
const unexpectedStorage = (): never => {
  throw new Error("Registry inspection cannot perform storage work");
};
const registryBucket: R2Bucket = {
  ...bucket,
  get: unexpectedStorage,
  put: unexpectedStorage,
  list: unexpectedStorage,
  createMultipartUpload: unexpectedStorage,
  resumeMultipartUpload: unexpectedStorage,
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

test("the Safe pool pilot takes the financial step beside Account recovery", async () => {
  const safePool = makeSafePoolPilotJob(
    {},
    {
      environment: "production",
      attestationId: "megapot-base-safe-pilot",
      rpcUrl: "https://rpc.invalid/",
      requiredConfirmations: 3,
      productionEnabled: false,
      minimumEntrySeconds: 3_600,
      observationTtlMs: 300_000,
      commitmentBucket: {} as MegapotRewardsJobOptions["commitmentBucket"],
      commitmentPublicOrigin: "https://commitments.invalid",
    },
  );
  const study = makeStudySpokenAnswerRecoveryJob({}, bucket);
  // Both write reward legs and credits, so they cannot be separate writers.
  await expect(Effect.runPromise(buildJobRegistry([study, safePool]))).rejects.toMatchObject({
    reason: "duplicate-table-writer",
  });
  const declarations = makeJobsWorkerDeclarations(
    {},
    "https://rpc.invalid/",
    { enabled: false },
    "production",
    null,
    false,
    registryBucket,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    safePool,
  );
  const registry = await Effect.runPromise(buildJobRegistry(declarations));
  expect(registry.byName.has(study.name)).toBe(false);
  const joint = registry.byName.get(safePool.name);
  if (joint === undefined) throw new Error("Joint writer missing");
  expect(joint.schedule).toBe("* * * * *");
  expect(new Set(joint.writes)).toEqual(new Set([...study.writes, ...safePool.writes]));
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

test.each([false, true])(
  "the real serving registry owns Funding and cycle writes once with Study %s",
  async (withStudy) => {
    const runtime = { run: () => Effect.void, ensure: () => Effect.void };
    const funding = makeSongMegapotFundingRecoveryJob({
      runtime,
      enabled: true,
      limit: 1,
      ensure: runtime.ensure,
    });
    const megapot = makeMegapotRewardsJob({}, options);
    await expect(Effect.runPromise(buildJobRegistry([funding, megapot]))).rejects.toMatchObject({
      reason: "duplicate-table-writer",
      key: "postgres:song_reward_offer_legs",
    });
    const declarations = makeJobsWorkerDeclarations(
      {},
      "https://rpc.invalid/",
      { enabled: false },
      "staging",
      options,
      false,
      withStudy ? registryBucket : undefined,
      undefined,
      true,
      undefined,
      undefined,
      undefined,
      runtime,
    );
    const registry = await Effect.runPromise(buildJobRegistry(declarations));
    expect(registry.byName.has(funding.name)).toBe(false);
    const joint = registry.byName.get(megapot.name);
    if (joint === undefined) throw new Error("Joint writer missing");
    const study = withStudy ? makeStudySpokenAnswerRecoveryJob({}, bucket) : undefined;
    expect(new Set(joint.writes)).toEqual(
      new Set([...megapot.writes, ...SONG_FUNDING_RECOVERY_WRITES, ...(study?.writes ?? [])]),
    );
    expect(new Set(joint.reads)).toEqual(
      new Set([...megapot.reads, ...funding.reads, ...(study?.reads ?? [])]),
    );
    expect(joint.timeout).toBe("50 seconds");
    expect(joint.requiresAdapterSafety).toBe(true);
  },
);

test("Funding waits for the settled cycle and shares the original attempt clock", async () => {
  const trace: string[] = [];
  let now = 1000;
  let release = () => {};
  let started = () => {};
  const runningCycle = new Promise<void>((resolve) => {
    started = resolve;
  });
  const settledCycle = new Promise<void>((resolve) => {
    release = resolve;
  });
  const running = Effect.runPromise(
    runSerialStudyMegapotRecovery({
      study: Effect.sync(() => {
        trace.push("study");
        now = 2000;
      }),
      financial: Effect.promise(async () => {
        trace.push("cycle");
        started();
        await settledCycle;
        now = 25_000;
        trace.push("cycle-settled");
      }),
      funding: Effect.sync(() => {
        trace.push("funding");
      }),
      outerStartedAtMs: 1000,
      now: () => now,
    }),
  );
  try {
    await runningCycle;
    expect(trace).toEqual(["study", "cycle"]);
  } finally {
    release();
  }
  expect(await running).toEqual({
    financial: "ran",
    remainingMs: 49_000,
    funding: "ran",
    fundingRemainingMs: 26_000,
  });
  expect(trace).toEqual(["study", "cycle", "cycle-settled", "funding"]);
});

test.each([28_000, 29_000, 51_000])(
  "the original clock defers Funding at %s without starting or retrying it",
  async (afterCycle) => {
    let now = 1000,
      calls = 0;
    const result = await Effect.runPromise(
      runSerialStudyMegapotRecovery({
        study: Effect.void,
        financial: Effect.sync(() => {
          now = afterCycle;
        }),
        funding: Effect.sync(() => {
          calls++;
        }),
        outerStartedAtMs: 1000,
        now: () => now,
      }),
    );
    expect(result).toEqual({
      financial: "ran",
      remainingMs: 50_000,
      funding: "skipped_remaining_budget",
      fundingRemainingMs: 51_000 - afterCycle,
    });
    expect(calls).toBe(0);
  },
);

test("Funding COMMIT uncertainty ends the tick without replaying either stage", async () => {
  const failure = new ControlPlaneTransactionOutcomeUnknown({
    phase: "commit",
    label: "song-funding.work.finish",
    limitMs: 2000,
    elapsedMs: 2000,
  });
  let cycleCalls = 0,
    fundingCalls = 0;
  const result = await Effect.runPromise(
    Effect.flip(
      runSerialStudyMegapotRecovery({
        study: Effect.void,
        financial: Effect.sync(() => {
          cycleCalls++;
        }),
        funding: Effect.sync(() => {
          fundingCalls++;
        }).pipe(Effect.andThen(Effect.fail(failure))),
        outerStartedAtMs: 1000,
        now: () => 1000,
      }),
    ),
  );
  expect(result).toBe(failure);
  expect([cycleCalls, fundingCalls]).toEqual([1, 1]);
});

test("Funding timeout awaits interrupted cleanup and never retries the settled cycle", async () => {
  const trace: string[] = [];
  await expect(
    Effect.runPromise(
      runSerialStudyMegapotRecovery({
        study: Effect.void,
        financial: Effect.sync(() => {
          trace.push("cycle");
        }),
        funding: Effect.never.pipe(
          Effect.ensuring(
            Effect.promise(async () => {
              await new Promise((resolve) => setTimeout(resolve, 5));
              trace.push("funding-closed");
            }),
          ),
        ),
        outerStartedAtMs: 1000,
        now: () => 1000,
      }),
    ),
  ).rejects.toMatchObject({ _tag: "TimeoutError" });
  expect(trace).toEqual(["cycle", "funding-closed"]);
}, 20_000);
