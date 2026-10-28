import { ControlPlaneDb } from "@pirate/application";
import { Effect } from "effect";

type Work = "financial" | "funding";
const ATTEMPT_MS = 50_000;
// Five bounded database statements and connection close after interruption.
const CLOSE_TAIL_MS = 11_000;
const MINIMUM_WORK_MS = 10_000;

export const takeSafeRecoveryTurn = Effect.gen(function* () {
  const db = yield* ControlPlaneDb;
  const result = yield* db.execute<{ first_work: Work }>({
    label: "safe-pool-recovery.turn.take",
    text: "SELECT take_reward_joint_cycle_turn_v1() AS first_work",
    values: [],
    readonly: false,
  });
  const work = result.rows[0]?.first_work;
  if (result.rows.length !== 1 || (work !== "financial" && work !== "funding"))
    throw Error("Invalid durable recovery turn");
  return work;
});

/** Study drains one closed checkpoint before any cutoff or financial work.
 * Funding and settlement take turns getting the first remaining work window.
 * Advancing the durable turn before work prevents a slow provider from claiming
 * every tick, including after a restart. Uncertain writes stop this attempt;
 * neither a timeout nor a lost acknowledgement is treated as a successful yield.
 */
export const runFairSafePoolRecovery = Effect.fn("FairSafePoolRecovery.run")(function* <R>(input: {
  readonly study: Effect.Effect<void, unknown, R>;
  readonly financial: Effect.Effect<void, unknown, R>;
  readonly funding?: Effect.Effect<void, unknown, R>;
  readonly takeTurn: Effect.Effect<Work, unknown, R>;
  readonly outerStartedAtMs: number;
  readonly now: () => number;
}) {
  let previous = input.outerStartedAtMs;
  const remaining = () => {
    const now = input.now();
    if (!Number.isFinite(previous) || !Number.isFinite(now) || now < previous)
      throw Error("Original joint attempt clock unavailable");
    previous = now;
    return ATTEMPT_MS - (now - input.outerStartedAtMs);
  };
  // The small batch is the normal yield boundary. This deadline only fences a
  // stuck native operation; failure never permits later money work in this tick.
  const studyBudget = Math.min(12_000, remaining() - CLOSE_TAIL_MS - MINIMUM_WORK_MS);
  if (studyBudget <= 0) throw Error("Joint attempt setup exhausted Study budget");
  yield* input.study.pipe(Effect.timeout(studyBudget));
  const first = input.funding === undefined ? "financial" : yield* input.takeTurn;
  const order: readonly Work[] =
    input.funding === undefined
      ? ["financial"]
      : [first, first === "financial" ? "funding" : "financial"];
  const completed: Work[] = [];
  for (const work of order) {
    const budget = remaining() - CLOSE_TAIL_MS;
    if (budget < MINIMUM_WORK_MS) break;
    const effect = work === "financial" ? input.financial : input.funding;
    if (effect === undefined) throw Error("Missing selected recovery stage");
    yield* effect.pipe(Effect.timeout(budget));
    completed.push(work);
  }
  return { first, completed, remainingMs: remaining() };
});
