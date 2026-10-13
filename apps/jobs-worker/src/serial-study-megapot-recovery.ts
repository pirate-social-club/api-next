// One actual registry writer when both source families are composed.
import { AlertCollector, type ControlPlaneDb } from "@pirate/application";
import type { AlertSink } from "@pirate/platform-cf";
import { Effect, Schedule } from "effect";
import { MEGAPOT_REWARDS_BOUNDED_CLOSE_TIMEOUT_MS, MEGAPOT_REWARDS_BOUNDED_STATEMENT_TIMEOUT_MS } from "./megapot-rewards-cycle.ts";
import { JobContext, type JobDeclaration } from "./registry.ts";

type Job = JobDeclaration<unknown, ControlPlaneDb | AlertCollector>;
const OUTER_BUDGET_MS = 50_000;
// The retained funding/liveness interrupt tail plus its existing summary margin.
const MINIMUM_FINANCIAL_TAIL_MS = 5 * MEGAPOT_REWARDS_BOUNDED_STATEMENT_TIMEOUT_MS
  + MEGAPOT_REWARDS_BOUNDED_CLOSE_TIMEOUT_MS + 2_000;

/** Original start clock includes Study; it is never reset for the money stage.
 * Unknown Study COMMIT/storage stops before ANY financial effect starts.
 */
export const runSerialStudyMegapotRecovery = Effect.fn("SerialStudyMegapot.run")(function* <R>(input: {
  readonly study: Effect.Effect<void, unknown, R>;
  readonly financial: Effect.Effect<void, unknown, R>;
  readonly outerStartedAtMs: number;
  readonly now: () => number;
}) {
  const initial = input.now();
  if (!Number.isFinite(initial) || !Number.isFinite(input.outerStartedAtMs) || initial < input.outerStartedAtMs)
    throw new Error("Original joint source clock unavailable");
  yield* input.study.pipe(Effect.timeout("45 seconds"));
  const current = input.now();
  if (!Number.isFinite(current) || current < initial) throw new Error("Original joint source clock changed");
  const remainingMs = OUTER_BUDGET_MS - (current - input.outerStartedAtMs);
  if (remainingMs <= MINIMUM_FINANCIAL_TAIL_MS) return { financial: "skipped_remaining_budget" as const, remainingMs };
  yield* input.financial;
  return { financial: "ran" as const, remainingMs };
});

export function makeSerialStudyMegapotRecoveryJob(sink: AlertSink, study: Job, megapot: Job): Job {
  if (study.name !== "study-spoken-answer.recover-expired" || megapot.name !== "megapot-rewards.cycle"
    || study.schedule !== "* * * * *" || megapot.schedule !== study.schedule
    || study.timeout !== "45 seconds" || megapot.timeout !== "50 seconds")
    throw new Error("Exact retained source job declarations required");
  const reads = [...new Set([...study.reads, ...megapot.reads])];
  const writes = [...new Set([...study.writes, ...megapot.writes])];
  const expectedFailures = [...new Set([...study.expectedFailures, ...megapot.expectedFailures])];
  const expectedFailure = Object.fromEntries(expectedFailures.map(tag => [tag, "high" as const]));
  const run = Effect.gen(function* () {
    const context = yield* JobContext;
    // A runner must supply this original clock; no Date.now fallback can
    // erase setup/retry elapsed time or invent a fresh financial budget.
    if (context.startedAtMs === undefined) throw new Error("Original joint attempt clock unavailable");
    const result = yield* runSerialStudyMegapotRecovery({ study: study.run, financial: megapot.run,
      outerStartedAtMs: context.startedAtMs, now: Date.now });
    if (result.financial === "skipped_remaining_budget") {
      const collector = yield* AlertCollector;
      yield* collector.emit({ key: "megapot-rewards:serial-source-budget-held", severity: "high",
        body: "Study recovery consumed the bounded joint attempt; financial work remains held for a later tick." });
      (sink.log ?? console.info)("megapot.rewards.serial-source-budget", {
        event: "megapot.rewards.serial-source-budget", job: megapot.name,
        financial: result.financial, remaining_ms: result.remainingMs, started_at_ms: context.startedAtMs,
      });
    }
  });
  return { ...megapot, reads, writes, expectedFailures,
    severity: { ...megapot.severity, expectedFailure, timeout: "high", transactionOutcomeUnknown: "high", defect: "high" },
    retry: Schedule.recurs(0), run };
}
