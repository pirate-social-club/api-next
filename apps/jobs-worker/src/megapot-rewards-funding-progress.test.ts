import { expect, test } from "bun:test";
import { Effect, Fiber } from "effect";
import {
  type MegapotRewardsRuntime,
  runMegapotFundingStep,
  runMegapotRewardsCycle,
} from "./megapot-rewards-cycle.ts";

// A live stack spends longer on the work before funding than funding's start
// deadline allows. These tests hold that shape with real timers: every cycle is
// slow, and what matters is whether funding makes progress across cycles.
const deadlines = { budgetMs: 60, latestStartMs: 60, hardStopMs: 120, reportByMs: 400 };
const settlementMs = 200;
const idle = () => Effect.succeed({ kind: "complete" });

function stack(
  options: {
    readonly pending?: readonly string[];
    readonly observe?: (id: string) => Effect.Effect<{ kind: string }, unknown>;
  } = {},
) {
  const pending = [...(options.pending ?? ["funding-1"])];
  const log: string[] = [];
  const runtime: MegapotRewardsRuntime = {
    reconcile: idle,
    reconcileFunding:
      options.observe ??
      ((id) =>
        Effect.sync(() => {
          log.push(`confirmed:${id}`);
          pending.splice(pending.indexOf(id), 1);
          return { kind: "confirmed" };
        })),
    observeDrawing: () => Effect.succeed(false),
    observeSolvency: idle,
    freezeDue: () => Effect.succeed([]),
    publishCommitment: idle,
    approve: idle,
    closeUnavailablePurchase: idle,
    purchase: idle,
    sweep: idle,
    claim: idle,
    allocate: idle,
    closeExpiredOffers: () => Effect.succeed([]),
    refund: () => Effect.sync(() => log.push("refund")).pipe(Effect.as({ kind: "complete" })),
    payout: () => Effect.sync(() => log.push("payout")).pipe(Effect.as({ kind: "complete" })),
  };
  const work = {
    // The work before funding is slow on every cycle.
    loadChainEffects: () => Effect.sleep(settlementMs).pipe(Effect.as([])),
    loadDrawings: () => Effect.succeed([]),
    loadRefunds: () => Effect.succeed(["refund-1"]),
    loadCredits: () => Effect.succeed(["credit-1"]),
    loadPendingFunding: () =>
      Effect.sync(() => {
        log.push("listed");
        return [...pending];
      }),
    loadAgedPending: () => Effect.succeed([]),
  } as unknown as Parameters<typeof runMegapotRewardsCycle>[0]["work"];
  return { log, pending, runtime, work };
}

/** The job's shape: funding started on its own before setup, awaited by the cycle. */
function jobCycle(
  fixture: ReturnType<typeof stack>,
  timing: { readonly dispatchDelayMs?: number; readonly setupMs?: number } = {},
) {
  return Effect.gen(function* () {
    const jobStartedAt = Date.now();
    if (timing.dispatchDelayMs) yield* Effect.sleep(timing.dispatchDelayMs);
    const funding = yield* Effect.forkChild(
      runMegapotFundingStep({
        loadPendingFunding: fixture.work.loadPendingFunding,
        reconcileFunding: fixture.runtime.reconcileFunding,
        jobStartedAt,
        deadlines,
      }),
      { startImmediately: true },
    );
    if (timing.setupMs) yield* Effect.sleep(timing.setupMs);
    const summary = yield* runMegapotRewardsCycle({
      work: fixture.work,
      runtime: fixture.runtime,
      jobStartedAt,
      fundingDeadlines: deadlines,
      funding: Fiber.join(funding),
    });
    return { summary, elapsedMs: Date.now() - jobStartedAt };
  });
}

const inlineCycle = (fixture: ReturnType<typeof stack>) =>
  runMegapotRewardsCycle({
    work: fixture.work,
    runtime: fixture.runtime,
    jobStartedAt: Date.now(),
    fundingDeadlines: deadlines,
  });

test("run last, funding is skipped on every slow cycle and says so instead of reporting nothing pending", async () => {
  const fixture = stack();
  for (let cycle = 0; cycle < 4; cycle++) {
    const summary = await Effect.runPromise(inlineCycle(fixture));
    expect(summary.fundingStep).toBe("skipped_deadline_passed");
    // Nothing was listed, so there is no count of what was put off.
    expect(summary).not.toHaveProperty("fundingObserved");
    expect(summary).not.toHaveProperty("fundingDeferred");
    expect(summary).toMatchObject({ refunded: 1, paid: 1 });
  }
  expect(fixture.log).not.toContain("listed");
  expect(fixture.pending).toEqual(["funding-1"]);
});

test("started by the job, funding is listed on every slow cycle and a waiting transfer is confirmed on the first", async () => {
  const fixture = stack();
  const first = await Effect.runPromise(jobCycle(fixture));
  expect(first.summary).toMatchObject({
    fundingStep: "ran",
    fundingObserved: 1,
    fundingConfirmed: 1,
    refunded: 1,
    paid: 1,
  });
  // Confirmed while the slow work before it was still running, not after it.
  expect(fixture.log.indexOf("confirmed:funding-1")).toBeLessThan(fixture.log.indexOf("refund"));
  for (let cycle = 0; cycle < 3; cycle++) {
    const next = await Effect.runPromise(jobCycle(fixture));
    // Listed again and found nothing: that is "ran", with no counts.
    expect(next.summary.fundingStep).toBe("ran");
    expect(next.summary).not.toHaveProperty("fundingObserved");
    expect(next.summary).toMatchObject({ refunded: 1, paid: 1 });
  }
  expect(fixture.log.filter((entry) => entry === "listed")).toHaveLength(4);
  expect(fixture.log.filter((entry) => entry.startsWith("confirmed:"))).toHaveLength(1);
});

test("slow setup after the step has started does not cost funding its turn", async () => {
  const fixture = stack();
  const { summary } = await Effect.runPromise(jobCycle(fixture, { setupMs: 150 }));
  expect(summary).toMatchObject({ fundingStep: "ran", fundingConfirmed: 1, refunded: 1, paid: 1 });
});

test("a job dispatched after the start deadline skips funding visibly and still settles", async () => {
  const fixture = stack();
  const { summary } = await Effect.runPromise(jobCycle(fixture, { dispatchDelayMs: 90 }));
  expect(summary.fundingStep).toBe("skipped_deadline_passed");
  expect(summary).not.toHaveProperty("fundingDeferred");
  expect(summary).toMatchObject({ refunded: 1, paid: 1 });
  expect(fixture.log).not.toContain("listed");
});

test("a funding observation that never answers is cut off at its hard stop while refunds and payouts go on", async () => {
  const fixture = stack({ observe: () => Effect.never });
  for (let cycle = 0; cycle < 3; cycle++) {
    const { summary, elapsedMs } = await Effect.runPromise(jobCycle(fixture));
    expect(summary).toMatchObject({ fundingStep: "ran", fundingObserved: 1, refunded: 1, paid: 1 });
    expect(summary).not.toHaveProperty("fundingConfirmed");
    expect(summary.failures).toEqual(["MegapotRewardsFundingDeadlineExceeded"]);
    // The cycle took as long as its own slow work, not longer for the hung observation.
    expect(elapsedMs).toBeLessThan(settlementMs + 150);
  }
  expect(fixture.log.filter((entry) => entry === "refund")).toHaveLength(3);
  expect(fixture.log.filter((entry) => entry === "payout")).toHaveLength(3);
});

test("several waiting transfers are all reached across slow cycles", async () => {
  const fixture = stack({ pending: ["funding-1", "funding-2", "funding-3"] });
  for (let cycle = 0; cycle < 3 && fixture.pending.length > 0; cycle++)
    await Effect.runPromise(jobCycle(fixture));
  expect(fixture.pending).toEqual([]);
});
