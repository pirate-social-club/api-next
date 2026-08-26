import type { MegapotDrawingObservationFailure } from "@pirate/application";
import type {
  MegapotChainEffectWork,
  MegapotDrawingWork,
  MegapotWorkStore,
} from "@pirate/platform-cf/megapot-work-repository";
import { Effect } from "effect";

export const MEGAPOT_REWARDS_CYCLE_JOB = "megapot-rewards.cycle";
export const MEGAPOT_REWARDS_CYCLE_LANE = "megapot-rewards";
export const MEGAPOT_REWARDS_CYCLE_SCHEDULE = "* * * * *";
export const MEGAPOT_REWARDS_CYCLE_TIMEOUT = "50 seconds";

export function observeMegapotDrawingForCycle<A>(
  operation: Effect.Effect<A, MegapotDrawingObservationFailure>,
): Effect.Effect<boolean, MegapotDrawingObservationFailure> {
  return operation.pipe(
    Effect.as(true),
    Effect.catchTag("MegapotDrawingObservationRejected", (error) =>
      error.reason === "drawing-closed" ? Effect.succeed(false) : Effect.fail(error),
    ),
  );
}

export interface MegapotRewardsRuntime {
  readonly reconcile: (work: MegapotChainEffectWork) => Effect.Effect<unknown, unknown>;
  readonly observeDrawing: () => Effect.Effect<boolean, unknown>;
  readonly observeSolvency: () => Effect.Effect<unknown, unknown>;
  readonly freezeDue: (limit: number) => Effect.Effect<readonly unknown[], unknown>;
  readonly publishCommitment: (work: MegapotDrawingWork) => Effect.Effect<unknown, unknown>;
  readonly approve: (
    work: MegapotDrawingWork,
  ) => Effect.Effect<Readonly<{ readonly kind: string }>, unknown>;
  readonly purchase: (work: MegapotDrawingWork) => Effect.Effect<unknown, unknown>;
  readonly sweep: (work: MegapotDrawingWork) => Effect.Effect<unknown, unknown>;
  readonly claim: (work: MegapotDrawingWork) => Effect.Effect<unknown, unknown>;
  readonly allocate: (work: MegapotDrawingWork) => Effect.Effect<unknown, unknown>;
  readonly closeExpiredOffers: (limit: number) => Effect.Effect<readonly unknown[], unknown>;
  readonly refund: (fundingEffectId: string) => Effect.Effect<unknown, unknown>;
  readonly payout: (creditId: string) => Effect.Effect<unknown, unknown>;
}

export type MegapotRewardsCycleSummary = Readonly<{
  reconciled: number;
  observed: number;
  frozen: number;
  committed: number;
  purchased: number;
  swept: number;
  claimed: number;
  allocated: number;
  terminalOffers: number;
  refunded: number;
  paid: number;
  failures: readonly string[];
}>;

function failureTag(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = error._tag;
    if (typeof tag === "string" && tag.length > 0) return tag;
  }
  return "MegapotRewardsCycleExpectedFailure";
}

const partition = <A, B>(values: readonly A[], f: (value: A) => Effect.Effect<B, unknown>) =>
  Effect.partition(values, f, { concurrency: 1 });

export function runMegapotRewardsCycle(input: {
  readonly work: MegapotWorkStore;
  readonly runtime: MegapotRewardsRuntime;
  readonly limit?: number;
}): Effect.Effect<MegapotRewardsCycleSummary, unknown> {
  return Effect.gen(function* () {
    const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return yield* Effect.fail(new Error("invalid Megapot rewards cycle limit"));
    }
    const failures: string[] = [];
    const recordFailures = (values: readonly unknown[]) => {
      failures.push(...values.map(failureTag));
    };

    const pending = yield* input.work.loadChainEffects(limit);
    const [reconcileFailures, reconciled] = yield* partition(pending, input.runtime.reconcile);
    recordFailures(reconcileFailures);

    const drawingObserved = yield* input.runtime.observeDrawing();
    yield* input.runtime.observeSolvency();
    const frozen = yield* input.runtime.freezeDue(limit);

    const frozenDrawings = yield* input.work.loadDrawings({
      statuses: ["cutoff_frozen"],
      limit,
    });
    const [commitFailures, committed] = yield* partition(
      frozenDrawings,
      input.runtime.publishCommitment,
    );
    recordFailures(commitFailures);

    const committedDrawings = yield* input.work.loadDrawings({ statuses: ["committed"], limit });
    const [purchaseFailures, purchaseResults] = yield* partition(committedDrawings, (work) =>
      Effect.gen(function* () {
        const approval = yield* input.runtime.approve(work);
        if (approval.kind !== "not_required" && approval.kind !== "confirmed") return false;
        yield* input.runtime.purchase(work);
        return true;
      }),
    );
    recordFailures(purchaseFailures);

    const purchasedDrawings = yield* input.work.loadDrawings({
      statuses: ["tickets_confirmed", "drawing_pending"],
      limit,
    });
    const [sweepFailures, swept] = yield* partition(purchasedDrawings, input.runtime.sweep);
    recordFailures(sweepFailures);

    const winningDrawings = yield* input.work.loadDrawings({
      statuses: ["winnings_detected"],
      limit,
    });
    const [claimFailures, claimed] = yield* partition(winningDrawings, input.runtime.claim);
    recordFailures(claimFailures);

    const claimedDrawings = yield* input.work.loadDrawings({ statuses: ["claimed"], limit });
    const [allocationFailures, allocated] = yield* partition(
      claimedDrawings,
      input.runtime.allocate,
    );
    recordFailures(allocationFailures);

    const terminalOffers = yield* input.runtime.closeExpiredOffers(limit);

    const refunds = yield* input.work.loadRefunds(limit);
    const [refundFailures, refunded] = yield* partition(refunds, (fundingEffectId) =>
      Effect.gen(function* () {
        yield* input.runtime.observeSolvency();
        return yield* input.runtime.refund(fundingEffectId);
      }),
    );
    recordFailures(refundFailures);

    const credits = yield* input.work.loadCredits(limit);
    const [payoutFailures, paid] = yield* partition(credits, (creditId) =>
      Effect.gen(function* () {
        yield* input.runtime.observeSolvency();
        return yield* input.runtime.payout(creditId);
      }),
    );
    recordFailures(payoutFailures);

    return {
      reconciled: reconciled.length,
      observed: drawingObserved ? 1 : 0,
      frozen: frozen.length,
      committed: committed.length,
      purchased: purchaseResults.filter(Boolean).length,
      swept: swept.length,
      claimed: claimed.length,
      allocated: allocated.length,
      terminalOffers: terminalOffers.length,
      refunded: refunded.length,
      paid: paid.length,
      failures,
    };
  });
}
