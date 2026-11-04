import { expect, mock, test } from "bun:test";
import { AlertCollector, ControlPlaneDb } from "@pirate/application";
import { Effect, Fiber, Layer } from "effect";
import type { MegapotRewardsJobOptions } from "./megapot-rewards.ts";

mock.module("cloudflare:workers", () => ({ DurableObject: class DurableObject {} }));
const { makeMegapotRewardsJob } = await import("./megapot-rewards.ts");
const { JobContext } = await import("./registry.ts");

// The real job, with a bounded session for funding as every deployment has. The
// funding step it starts must belong to the whole attempt: these tests end the
// attempt early, in setup, in the cycle and by interruption, and check the step
// is no longer running when the attempt returns and never overlaps the next one.
const custodyKey = `0x${"11".repeat(32)}`;

function harness(
  faults: {
    readonly invalidCustodyKey?: boolean;
    readonly fundingListingMs?: number;
    readonly jobStatementMs?: number;
  } = {},
) {
  const funding = { running: 0, peak: 0, started: 0, finished: 0, interrupted: 0 };
  const events: Array<{ event: string; fields: Record<string, unknown> }> = [];
  const alerts: string[] = [];
  const session = (slowMs: number, track: boolean): ControlPlaneDb["Service"] => {
    // Only the funding listing is the funding step; the liveness read shares the session.
    const execute = (statement: { label?: string }) => {
      const counted = track && statement.label === "megapot-work.pending-funding.read";
      return Effect.gen(function* () {
        if (counted) {
          funding.started += 1;
          funding.running += 1;
          funding.peak = Math.max(funding.peak, funding.running);
        }
        yield* Effect.sleep(counted || !track ? slowMs : 0);
        if (counted) funding.finished += 1;
        return { rows: [], rowCount: 0 };
      }).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            if (counted) funding.interrupted += 1;
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (counted) funding.running -= 1;
          }),
        ),
      );
    };
    const transaction = { execute };
    return {
      execute,
      withTransaction: (use: (value: typeof transaction) => unknown) => use(transaction),
    } as unknown as ControlPlaneDb["Service"];
  };
  const options: MegapotRewardsJobOptions = {
    environment: "test",
    workerVersion: { id: "version-1", tag: "", timestamp: "2026-10-06T00:00:00.000Z" },
    attestationId: "attestation-1",
    rpcUrl: "http://rpc.invalid",
    custodyPrivateKey: faults.invalidCustodyKey ? "not-a-key" : custodyKey,
    boundedControlPlane: Layer.succeed(
      ControlPlaneDb,
      session(faults.fundingListingMs ?? 150, true),
    ),
    gasTopupPrivateKey: null,
    commitmentBucket: {} as MegapotRewardsJobOptions["commitmentBucket"],
    commitmentPublicOrigin: "https://commitments.invalid",
    requiredConfirmations: 3,
    observationTtlMs: 300_000,
    approvedAllowanceAtomic: 1n,
    purchaseSafetyMarginSeconds: 60,
    gasLimitMultiplierBps: 12_000,
    nativeGasReserveFloorWei: 1n,
    externalSponsorDailyTicketCeiling: 1,
    externalSponsorDailySpendCeilingAtomic: 1n,
    sharedSponsorDailyTicketCeiling: 1,
    sharedSponsorDailySpendCeilingAtomic: 1n,
  };
  const job = makeMegapotRewardsJob(
    {
      log: (event: string, fields: unknown) => events.push({ event, fields: fields as never }),
    } as never,
    options,
  );
  const attempt = (startedAtMs = Date.now()) =>
    job.run.pipe(
      Effect.provideService(JobContext, {
        owner: "test",
        attemptId: "attempt-1",
        startedAtMs,
        lease: () => {
          throw new Error("unused");
        },
        adapterSafety: { markAbortedOrFenced: () => undefined, isProven: () => true },
      }),
      Effect.provideService(ControlPlaneDb, session(faults.jobStatementMs ?? 0, false)),
      Effect.provideService(AlertCollector, {
        emit: (alert) => Effect.sync(() => void alerts.push(alert.key)),
      }),
    ) as Effect.Effect<void, unknown>;
  return { funding, events, alerts, attempt };
}

const summaryOf = (h: ReturnType<typeof harness>) =>
  h.events.find((entry) => entry.event === "megapot.rewards.cycle")?.fields;
const timingOf = (h: ReturnType<typeof harness>) =>
  h.events.find((entry) => entry.event === "megapot.rewards.cycle.timing")?.fields as
    | { elapsed_ms: Record<string, number>; funding_step_status: string }
    | undefined;

test("the job starts funding before its own setup and reports that it ran", async () => {
  const h = harness({ jobStatementMs: 20 });
  await Effect.runPromise(h.attempt());
  expect(summaryOf(h)).toMatchObject({ schema_version: 5, funding_step_status: "ran" });
  const timing = timingOf(h);
  expect(timing?.funding_step_status).toBe("ran");
  // Setup spends time on the job's session; the step was already under way.
  expect(timing?.elapsed_ms.funding_started).toBeLessThan(timing?.elapsed_ms.setup ?? 0);
  expect(h.funding).toMatchObject({ running: 0, started: 1, finished: 1, interrupted: 0 });
  expect(h.alerts).not.toContain("megapot-rewards:funding-observation-skipped");
});

test("an attempt that fails in setup does not return while its funding step is still running", async () => {
  const h = harness({ invalidCustodyKey: true, fundingListingMs: 200 });
  const startedAt = Date.now();
  const exit = await Effect.runPromiseExit(h.attempt());
  expect(exit._tag).toBe("Failure");
  // The step was let finish, not cut off and not left behind.
  expect(h.funding).toMatchObject({ running: 0, started: 1, finished: 1, interrupted: 0 });
  expect(Date.now() - startedAt).toBeGreaterThanOrEqual(190);
});

test("a retry after a failed attempt never overlaps the earlier attempt's funding step", async () => {
  const h = harness({ invalidCustodyKey: true, fundingListingMs: 150 });
  const exit = await Effect.runPromiseExit(
    h.attempt().pipe(
      Effect.catch(() => h.attempt()),
      Effect.catch(() => h.attempt()),
    ),
  );
  expect(exit._tag).toBe("Failure");
  expect(h.funding).toMatchObject({ running: 0, started: 3, finished: 3, peak: 1 });
});

test("an interrupted attempt stops its funding step and waits for it to stop", async () => {
  const h = harness({ fundingListingMs: 5_000, jobStatementMs: 5_000 });
  const startedAt = Date.now();
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(h.attempt(), { startImmediately: true });
      yield* Effect.sleep(60);
      expect(h.funding.running).toBe(1);
      yield* Fiber.interrupt(fiber);
      // Stopped by the time the interruption is acknowledged.
      expect(h.funding).toMatchObject({ running: 0, started: 1, finished: 0, interrupted: 1 });
    }),
  );
  expect(Date.now() - startedAt).toBeLessThan(1_000);
});

test("a job dispatched after funding's start deadline says it skipped, alerts and reports degraded", async () => {
  const h = harness();
  await Effect.runPromise(h.attempt(Date.now() - 20_000));
  expect(summaryOf(h)).toMatchObject({
    funding_step_status: "skipped_deadline_passed",
    funding_observed_count: 0,
    funding_deferred_count: 0,
    outcome: "degraded",
  });
  expect(h.funding.started).toBe(0);
  expect(h.alerts).toContain("megapot-rewards:funding-observation-skipped");
});
