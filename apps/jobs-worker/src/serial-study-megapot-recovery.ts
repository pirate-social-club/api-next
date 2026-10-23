// One registry writer for Account Study, Megapot and shared-pot recovery.
import { AlertCollector, type ControlPlaneDb } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { Effect, Schedule } from "effect";
import {
  MEGAPOT_REWARDS_BOUNDED_CLOSE_TIMEOUT_MS,
  MEGAPOT_REWARDS_BOUNDED_STATEMENT_TIMEOUT_MS,
} from "./megapot-rewards-cycle.ts";
import { JobContext, type JobDeclaration } from "./registry.ts";

type Job = JobDeclaration<unknown, ControlPlaneDb | AlertCollector>;
const OUTER_BUDGET_MS = 50_000;
const MINIMUM_FINANCIAL_TAIL_MS =
  5 * MEGAPOT_REWARDS_BOUNDED_STATEMENT_TIMEOUT_MS +
  MEGAPOT_REWARDS_BOUNDED_CLOSE_TIMEOUT_MS +
  2_000;
const FUNDING_BUDGET_MS = 10_000;
const MINIMUM_FUNDING_TAIL_MS = FUNDING_BUDGET_MS + MINIMUM_FINANCIAL_TAIL_MS;

/** Keep the original attempt clock and await recovery before any financial
 * setup. A failed or uncertain recovery ends the tick without a retry.
 */
export const runSerialStudyMegapotRecovery = Effect.fn("SerialStudyMegapot.run")(function* <
  R,
>(input: {
  readonly study: Effect.Effect<void, unknown, R>;
  readonly financial: Effect.Effect<void, unknown, R>;
  readonly funding?: Effect.Effect<void, unknown, R>;
  readonly outerStartedAtMs: number;
  readonly now: () => number;
}) {
  const initial = input.now();
  if (
    !Number.isFinite(initial) ||
    !Number.isFinite(input.outerStartedAtMs) ||
    initial < input.outerStartedAtMs
  )
    throw new Error("Original joint source clock unavailable");
  yield* input.study.pipe(Effect.timeout("45 seconds"));
  const current = input.now();
  if (!Number.isFinite(current) || current < initial)
    throw new Error("Original joint source clock changed");
  const remainingMs = OUTER_BUDGET_MS - (current - input.outerStartedAtMs);
  if (remainingMs <= MINIMUM_FINANCIAL_TAIL_MS)
    return { financial: "skipped_remaining_budget" as const, remainingMs };
  yield* input.financial;
  if (input.funding === undefined) return { financial: "ran" as const, remainingMs };
  const afterFinancial = input.now();
  if (!Number.isFinite(afterFinancial) || afterFinancial < current)
    throw new Error("Original joint source clock changed");
  const fundingRemainingMs = OUTER_BUDGET_MS - (afterFinancial - input.outerStartedAtMs);
  // Keep the existing cycle ahead of new contribution recovery. Its committed
  // work is never replayed to make room for Funding. A short tick defers the
  // new stage without starting it or resetting the original attempt clock.
  if (fundingRemainingMs <= MINIMUM_FUNDING_TAIL_MS)
    return {
      financial: "ran" as const,
      remainingMs,
      funding: "skipped_remaining_budget" as const,
      fundingRemainingMs,
    };
  yield* input.funding.pipe(Effect.timeout(FUNDING_BUDGET_MS));
  return { financial: "ran" as const, remainingMs, funding: "ran" as const, fundingRemainingMs };
});

export function makeSerialStudyMegapotRecoveryJob(
  sink: AlertSink,
  study: Job | undefined,
  megapot: Job,
  funding?: Job,
): Job {
  if (
    megapot.name !== "megapot-rewards.cycle" ||
    megapot.schedule !== "* * * * *" ||
    megapot.timeout !== "50 seconds" ||
    (study === undefined && funding === undefined) ||
    (study !== undefined &&
      (study.name !== "study-spoken-answer.recover-expired" ||
        study.schedule !== megapot.schedule ||
        study.timeout !== "45 seconds")) ||
    (funding !== undefined &&
      (funding.name !== "song-megapot-funding-recovery.v2" ||
        funding.schedule !== megapot.schedule ||
        funding.timeout !== "1 minute"))
  )
    throw new Error("Exact retained source job declarations required");
  const sources = [
    megapot,
    ...(study === undefined ? [] : [study]),
    ...(funding === undefined ? [] : [funding]),
  ];
  const reads = [...new Set(sources.flatMap((job) => job.reads))];
  const writes = [...new Set(sources.flatMap((job) => job.writes))];
  const expectedFailures = [...new Set(sources.flatMap((job) => job.expectedFailures))];
  const expectedFailure = Object.fromEntries(expectedFailures.map((tag) => [tag, "high" as const]));
  const run = Effect.fn("SerialStudyMegapotRecoveryJob.run")(function* () {
    const context = yield* JobContext;
    if (context.startedAtMs === undefined)
      throw new Error("Original joint attempt clock unavailable");
    const result = yield* runSerialStudyMegapotRecovery({
      study: study?.run ?? Effect.void,
      financial: megapot.run,
      ...(funding === undefined ? {} : { funding: funding.run }),
      outerStartedAtMs: context.startedAtMs,
      now: Date.now,
    });
    if (result.financial === "skipped_remaining_budget") {
      const collector = yield* AlertCollector;
      yield* collector.emit({
        key: "megapot-rewards:serial-source-budget-held",
        severity: "high",
        body: "Study recovery consumed the bounded joint attempt; financial work remains held for a later tick.",
      });
      (sink.log ?? console.info)("megapot.rewards.serial-source-budget", {
        event: "megapot.rewards.serial-source-budget",
        job: megapot.name,
        financial: result.financial,
        remaining_ms: result.remainingMs,
        started_at_ms: context.startedAtMs,
      });
    }
    if ("funding" in result && result.funding === "skipped_remaining_budget") {
      const collector = yield* AlertCollector;
      yield* collector.emit({
        key: "song-megapot-funding:serial-source-budget-held",
        severity: "high",
        body: "The bounded joint cycle left insufficient time for contribution recovery; durable work remains queued for a later tick.",
      });
    }
  })();
  return {
    ...megapot,
    reads,
    writes,
    expectedFailures,
    severity: {
      ...megapot.severity,
      expectedFailure,
      timeout: "high",
      transactionOutcomeUnknown: "high",
      defect: "high",
    },
    retry: Schedule.recurs(0),
    run,
  };
}
