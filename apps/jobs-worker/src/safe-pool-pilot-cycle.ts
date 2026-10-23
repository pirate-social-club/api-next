import type {
  MegapotDrawingWork,
  MegapotDrawingWorkStatus,
} from "@pirate/platform-cf/megapot-work-repository";
import { Cause, Effect, Exit } from "effect";

export const SAFE_POOL_PILOT_CYCLE_JOB = "safe-pool-pilot.cycle";
export const SAFE_POOL_PILOT_CYCLE_LANE = "safe-pool-pilot";
// It runs as the financial step of the serial Study and funding job, whose contract
// is a one-minute schedule and a 50-second budget.
export const SAFE_POOL_PILOT_CYCLE_SCHEDULE = "* * * * *";
export const SAFE_POOL_PILOT_CYCLE_TIMEOUT = "50 seconds";
/** One RPC request bound, so a slow provider cannot hold the joint tick. */
export const SAFE_POOL_PILOT_RPC_TIMEOUT_MS = 5_000;
/**
 * Providers cap eth_getLogs ranges; Base Sepolia's public endpoint refuses more than
 * 201 blocks, which stalled the scan at 500 in the October 23 chain rehearsal. Each
 * window stays within that, and a cycle reads a few windows to catch up.
 */
export const SAFE_POOL_PILOT_SCAN_WINDOW_BLOCKS = 200;
const SAFE_POOL_PILOT_SCAN_WINDOWS_PER_CYCLE = 5;

/** Scans successive windows until the scanner reaches the settled head or the bound. */
export function scanSafeWindows<E>(
  scan: () => Effect.Effect<Readonly<{ scanned: boolean }>, E>,
  windows: number = SAFE_POOL_PILOT_SCAN_WINDOWS_PER_CYCLE,
): Effect.Effect<number, E> {
  return Effect.gen(function* () {
    let scanned = 0;
    while (scanned < windows) {
      const result = yield* scan();
      if (!result.scanned) break;
      scanned += 1;
    }
    return scanned;
  });
}
const SAFE_POOL_PILOT_CYCLE_LIMIT = 10;

type Step<A> = Effect.Effect<A, unknown>;
type BoundEffect = Readonly<{ effectId: string; kind: "ticket_purchase" | "reward_payout" }>;

/**
 * Everything the Safe pilot cycle does, one ticket-first pool step at a time. Every
 * step reads the chain or prepares a call for the owner's Safe; none signs or sends.
 */
export interface SafePoolPilotRuntime {
  readonly observeDrawing: () => Step<unknown>;
  readonly scan: () => Step<unknown>;
  readonly loadBoundEffects: (limit: number) => Step<readonly BoundEffect[]>;
  readonly settlePurchase: (effectId: string) => Step<unknown>;
  readonly settlePayout: (effectId: string) => Step<unknown>;
  readonly loadPendingFunding: (limit: number) => Step<readonly string[]>;
  readonly reconcileFunding: (fundingEffectId: string) => Step<unknown>;
  readonly closeUnexecutedPurchases: (limit: number) => Step<unknown>;
  readonly loadLegs: (limit: number) => Step<readonly string[]>;
  readonly preparePurchase: (legId: string) => Step<unknown>;
  readonly freezeDue: (limit: number) => Step<unknown>;
  readonly loadDrawings: (
    statuses: readonly MegapotDrawingWorkStatus[],
    limit: number,
  ) => Step<readonly MegapotDrawingWork[]>;
  readonly publishCommitment: (drawing: MegapotDrawingWork) => Step<unknown>;
  readonly sweep: (drawing: MegapotDrawingWork) => Step<unknown>;
  readonly settleClaim: (drawing: MegapotDrawingWork) => Step<unknown>;
  readonly prepareClaim: (drawing: MegapotDrawingWork) => Step<unknown>;
  readonly allocate: (drawing: MegapotDrawingWork) => Step<unknown>;
  readonly observeSolvency: () => Step<unknown>;
  readonly loadCredits: (limit: number) => Step<readonly string[]>;
  readonly preparePayout: (creditId: string) => Step<unknown>;
}

export type SafePoolPilotSummary = Readonly<{
  completed: Readonly<Record<string, number>>;
  failed: Readonly<Record<string, readonly string[]>>;
}>;

/** A failure's tag and reason only; provider text never reaches the summary. */
function describe(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const reason = "reason" in error && typeof error.reason === "string" ? `:${error.reason}` : "";
    return `${String(error._tag)}${reason}`;
  }
  return "defect";
}

/**
 * One pass over every ticket-first pool. Steps run in the order the pool moves, so
 * an execution bound early in the pass settles before later steps look at its
 * drawing. A failed item is recorded and the pass goes on.
 */
export function runSafePoolPilotCycle(
  runtime: SafePoolPilotRuntime,
  limit = SAFE_POOL_PILOT_CYCLE_LIMIT,
): Effect.Effect<SafePoolPilotSummary> {
  return Effect.gen(function* () {
    const completed: Record<string, number> = {};
    const failed: Record<string, string[]> = {};
    const attempt = <A>(name: string, effect: Step<A>) =>
      Effect.gen(function* () {
        const exit = yield* Effect.exit(effect);
        if (Exit.isSuccess(exit)) {
          completed[name] = (completed[name] ?? 0) + 1;
          return exit.value;
        }
        failed[name] = [...(failed[name] ?? []), describe(exit.cause)];
        return undefined;
      });
    const each = <T>(
      name: string,
      items: readonly T[] | undefined,
      run: (item: T) => Step<unknown>,
    ) => Effect.forEach(items ?? [], (item) => attempt(name, run(item)), { discard: true });

    yield* attempt("observe_drawing", runtime.observeDrawing());
    yield* attempt("scan", runtime.scan());
    const bound = yield* attempt("load_bound_effects", runtime.loadBoundEffects(limit));
    yield* each(
      "settle_purchase",
      bound?.filter((effect) => effect.kind === "ticket_purchase"),
      (effect) => runtime.settlePurchase(effect.effectId),
    );
    yield* each(
      "settle_payout",
      bound?.filter((effect) => effect.kind === "reward_payout"),
      (effect) => runtime.settlePayout(effect.effectId),
    );
    // A funding transfer that confirms activates its leg before tickets are prepared.
    yield* each(
      "reconcile_funding",
      yield* attempt("load_funding", runtime.loadPendingFunding(limit)),
      runtime.reconcileFunding,
    );
    yield* attempt("close_unexecuted_purchases", runtime.closeUnexecutedPurchases(limit));
    yield* each("prepare_purchase", yield* attempt("load_legs", runtime.loadLegs(limit)), (leg) =>
      runtime.preparePurchase(leg),
    );
    yield* attempt("freeze_due", runtime.freezeDue(limit));
    yield* each(
      "publish_commitment",
      yield* attempt("load_frozen", runtime.loadDrawings(["cutoff_frozen"], limit)),
      runtime.publishCommitment,
    );
    yield* each(
      "sweep",
      yield* attempt(
        "load_sweepable",
        runtime.loadDrawings(["committed", "drawing_pending"], limit),
      ),
      runtime.sweep,
    );
    const winning = yield* attempt(
      "load_winning",
      runtime.loadDrawings(["winnings_detected"], limit),
    );
    yield* each("settle_claim", winning, runtime.settleClaim);
    yield* each("prepare_claim", winning, runtime.prepareClaim);
    yield* each(
      "allocate",
      yield* attempt("load_claimed", runtime.loadDrawings(["claimed"], limit)),
      runtime.allocate,
    );
    yield* attempt("observe_solvency", runtime.observeSolvency());
    yield* each(
      "prepare_payout",
      yield* attempt("load_credits", runtime.loadCredits(limit)),
      runtime.preparePayout,
    );
    return { completed, failed };
  });
}
