import { afterAll, expect, mock, test } from "bun:test";
import { ControlPlaneDb } from "@pirate/application";
import { Effect, Layer, Schedule } from "effect";
import type { JobsWorkerEnv } from "./index.ts";
import type { JobDeclaration } from "./registry.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const platform = { ...(await import("@pirate/platform-cf")) };
const hns = { ...(await import("./hns-route-revalidation.ts")) };
const rewards = { ...(await import("./megapot-rewards.ts")) };
const balance = { ...(await import("./pipeline-balance.ts")) };
const telegram = { ...(await import("../../../packages/platform-cf/src/telegram-runtime.ts")) };
const gate = () => {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
};
let hnsStarted = gate(),
  notificationFailed = gate(),
  setup = gate(),
  hnsEnd = gate(),
  financialEnd = gate();
let balanceEnd = gate();
let hnsDone = false,
  financialDone = false,
  balanceDone = false,
  observedRewards = false;
const declaration = (name: string, lane: string, run: Effect.Effect<void>): JobDeclaration => ({
  name,
  lane,
  run,
  schedule: "* * * * *",
  timeout: "5 seconds",
  retry: Schedule.recurs(0),
  reads: [],
  writes: [],
  expectedFailures: [],
  severity: {
    expectedFailure: {},
    timeout: "high",
    transactionOutcomeUnknown: "high",
    defect: "high",
  },
});
const execute: ControlPlaneDb["Service"]["execute"] = () =>
  Effect.promise(async () => {
    await hnsStarted.promise;
    notificationFailed.release();
    throw new Error("notification-lane-injected-failure");
  });
mock.module("@pirate/platform-cf", () => ({
  ...platform,
  makeHyperdriveControlPlaneLayer: () =>
    Layer.succeed(ControlPlaneDb, { execute, withTransaction: (use) => use({ execute }) }),
  makeConfiguredAlertSink: () => ({}),
}));
mock.module("./hns-route-revalidation.ts", () => ({
  ...hns,
  makeHnsRouteRevalidationJob: () =>
    declaration(
      hns.HNS_ROUTE_REVALIDATION_JOB,
      "hns-route-revalidation",
      Effect.promise(async () => {
        hnsStarted.release();
        await hnsEnd.promise;
        hnsDone = true;
      }),
    ),
}));
mock.module("./megapot-rewards.ts", () => ({
  ...rewards,
  makeMegapotRewardsJob: () =>
    declaration(
      "megapot-rewards.cycle",
      "megapot-rewards",
      Effect.promise(async () => {
        await financialEnd.promise;
        financialDone = true;
      }),
    ),
}));
mock.module("./pipeline-balance.ts", () => ({
  ...balance,
  runPipelineBalanceSnapshots: async (input: { megapot: unknown }) => {
    observedRewards = input.megapot !== null;
    await balanceEnd.promise;
    balanceDone = true;
  },
}));
mock.module("../../../packages/platform-cf/src/telegram-runtime.ts", () => ({
  ...telegram,
  makeTelegramServices: async () => {
    await setup.promise;
    return null;
  },
}));
const { default: worker } = await import("./index.ts");
afterAll(() => {
  mock.module("@pirate/platform-cf", () => platform);
  mock.module("./hns-route-revalidation.ts", () => hns);
  mock.module("./megapot-rewards.ts", () => rewards);
  mock.module("./pipeline-balance.ts", () => balance);
  mock.module("../../../packages/platform-cf/src/telegram-runtime.ts", () => telegram);
});

for (const enabled of [false, true])
  test(`actual scheduled handler drains delayed siblings after notification failure, Rewards=${enabled}`, async () => {
    hnsStarted = gate();
    notificationFailed = gate();
    setup = gate();
    hnsEnd = gate();
    financialEnd = gate();
    balanceEnd = gate();
    hnsDone = false;
    financialDone = false;
    balanceDone = false;
    observedRewards = false;
    const waits: Promise<unknown>[] = [];
    const stub = {
      tryAcquireWithFence: async (_ttl: number, owner: string, now: number) => ({
        owner,
        generation: 1,
        expiresAt: now + 60000,
      }),
      releaseWithFence: async () => true,
      currentLease: async () => null,
    };
    const env = {
      CONTROL_PLANE: { connectionString: "unused-test-transport" },
      CRON_LOCK: { getByName: () => stub },
      CF_VERSION_METADATA: { id: "scheduled-fixture", tag: "", timestamp: "2026-10-16T00:00:00Z" },
      API_NEXT_ENV: "development",
      COMMUNITY_MAINTENANCE_ENABLED: "false",
      COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://unused.invalid/",
      HNS_OWNERSHIP_ENABLED: "true",
      HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "fixture",
      HNS_OWNERSHIP_CONFIGURATION_VERSION: "fixture-v1",
      HNS_OWNER_VERIFIER: {
        fetch: async () => {
          throw new Error("No provider I/O permitted");
        },
      },
      MEGAPOT_REWARDS_ENABLED: String(enabled),
      MEGAPOT_CHAIN_ID: "84532",
      MEGAPOT_V2_RPC_URL: "https://unused.invalid/",
      MEGAPOT_ATTESTATION_ID: "fixture",
      MEGAPOT_REQUIRED_CONFIRMATIONS: "3",
      MEGAPOT_OBSERVATION_TTL_SECONDS: "300",
      MEGAPOT_APPROVED_ALLOWANCE_ATOMIC: "1000000000",
      MEGAPOT_PURCHASE_SAFETY_MARGIN_SECONDS: "120",
      MEGAPOT_GAS_LIMIT_MULTIPLIER_BPS: "12000",
      MEGAPOT_NATIVE_GAS_RESERVE_FLOOR_WEI: "1000000000000000",
      MEGAPOT_EXTERNAL_SPONSOR_DAILY_TICKET_CEILING: "5",
      MEGAPOT_EXTERNAL_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "50000000",
      MEGAPOT_SHARED_SPONSOR_DAILY_TICKET_CEILING: "50",
      MEGAPOT_SHARED_SPONSOR_DAILY_SPEND_CEILING_ATOMIC: "500000000",
      // Existing deterministic development fixture key; no custody or RPC occurs.
      ...(enabled
        ? {
            MEGAPOT_CUSTODY_PRIVATE_KEY: `0x${"1".repeat(64)}`,
            MEGAPOT_COMMITMENT_PUBLIC_ORIGIN: "https://fixture.invalid/",
            MEGAPOT_COMMITMENTS: {},
          }
        : {}),
    } as unknown as JobsWorkerEnv;
    let settled = false,
      failure: unknown;
    const invoked = worker.scheduled(
      { scheduledTime: Date.UTC(2026, 9, 16), cron: "* * * * *" } as ScheduledEvent,
      env,
      {
        waitUntil: (promise) => {
          waits.push(promise);
          void promise.then(
            () => {
              settled = true;
            },
            (error) => {
              settled = true;
              failure = error;
            },
          );
        },
      } as ExecutionContext,
    );
    try {
      await notificationFailed.promise;
      expect(waits).toHaveLength(1); // registered even while Telegram setup waits
      expect(settled).toBe(false);
      setup.release();
      await invoked;
      expect(settled).toBe(false);
      hnsEnd.release();
      await Bun.sleep(5);
      expect(hnsDone).toBe(true);
      expect(settled).toBe(false);
      balanceEnd.release();
      await Bun.sleep(5);
      if (enabled) expect(settled).toBe(false);
      financialEnd.release();
      await Promise.allSettled(waits);
      expect(balanceDone).toBe(true);
      expect(financialDone).toBe(enabled);
      expect(observedRewards).toBe(enabled);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(String((failure as AggregateError).errors[0])).toContain(
        "notification-lane-injected-failure",
      );
    } finally {
      setup.release();
      hnsEnd.release();
      financialEnd.release();
      balanceEnd.release();
      await invoked;
      await Promise.allSettled(waits);
    }
  }, 10000);
