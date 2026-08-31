import type { Alert, MegapotDrawingObservationFailure } from "@pirate/application";
import type { PipelineLogFields } from "@pirate/platform-cf";
import type {
  MegapotAgedPending,
  MegapotAgedPendingFamily,
  MegapotChainEffectWork,
  MegapotDrawingWork,
  MegapotWorkStore,
} from "@pirate/platform-cf/megapot-work-repository";
import { Effect } from "effect";

export const MEGAPOT_REWARDS_CYCLE_JOB = "megapot-rewards.cycle";
export const MEGAPOT_REWARDS_CYCLE_LANE = "megapot-rewards";
export const MEGAPOT_REWARDS_CYCLE_SCHEDULE = "* * * * *";
export const MEGAPOT_REWARDS_CYCLE_TIMEOUT = "50 seconds";
const MEGAPOT_REWARDS_AGED_PENDING_THRESHOLD_SECONDS = 10 * 60;

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
  readonly purchase: (
    work: MegapotDrawingWork,
  ) => Effect.Effect<Readonly<{ readonly kind: string }>, unknown>;
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
  failureDiagnostics: readonly string[];
  agedPending: readonly MegapotAgedPending[] | null;
}>;

const REFUND_COORDINATOR_FAILURE_REASONS = [
  "deployment_attestation_mismatch",
  "gas_floor_insufficient",
  "invalid_config",
  "production_disabled",
  "receipt_evidence_invalid",
  "signer_mismatch",
  "solvency_insufficient",
] as const;

const REFUND_COORDINATOR_FAILURE_PHASES = [
  "configuration",
  "preflight",
  "prepare",
  "receipt",
] as const;

const AGED_PENDING_FAMILIES = [
  "chain_effects",
  "funding_effects",
  "drawings",
  "credits",
  "refund_liabilities",
] as const satisfies readonly MegapotAgedPendingFamily[];

const AGED_PENDING_ALERT_COPY: Readonly<
  Record<MegapotAgedPendingFamily, Readonly<{ key: string; body: string }>>
> = {
  chain_effects: {
    key: "megapot-rewards:aged-chain-effects",
    body: "Custody-signed reward chain effects exceeded the reconciliation grace period.",
  },
  funding_effects: {
    key: "megapot-rewards:aged-funding-effects",
    body: "Participant-bound reward funding effects exceeded the reconciliation grace period.",
  },
  drawings: {
    key: "megapot-rewards:aged-drawings",
    body: "Reward drawing transitions exceeded their persisted schedule grace period.",
  },
  credits: {
    key: "megapot-rewards:aged-credits",
    body: "Reward credits exceeded the payout grace period.",
  },
  refund_liabilities: {
    key: "megapot-rewards:aged-refund-liabilities",
    body: "Terminal reward legs retained refundable balances beyond the grace period.",
  },
};

function agedPendingCount(
  pending: readonly MegapotAgedPending[],
  family: MegapotAgedPendingFamily,
): number {
  return pending.find((entry) => entry.family === family)?.count ?? 0;
}

export function megapotRewardsLivenessAlerts(
  agedPending: readonly MegapotAgedPending[] | null,
): readonly Alert[] {
  if (agedPending === null) {
    return [
      {
        key: "megapot-rewards:aged-state-projection-unavailable",
        severity: "high",
        body: "The aggregate rewards liveness projection was unavailable.",
      },
    ];
  }
  return AGED_PENDING_FAMILIES.flatMap((family) => {
    if (agedPendingCount(agedPending, family) === 0) return [];
    return [{ ...AGED_PENDING_ALERT_COPY[family], severity: "high" as const }];
  });
}

export function writeMegapotRewardsCycleSnapshot(
  summary: MegapotRewardsCycleSummary,
  input: Readonly<{
    environment: string;
    emittedAt: string;
    durationMs: number;
    workerVersion: Readonly<{ id: string; tag: string; timestamp: string }>;
  }>,
  writer: (event: PipelineLogFields["event"], fields: PipelineLogFields) => void,
): boolean {
  try {
    const livenessAvailable = summary.agedPending !== null;
    const agedTotal = summary.agedPending?.reduce((total, entry) => total + entry.count, 0) ?? null;
    const oldestAgedPendingSeconds =
      summary.agedPending === null || summary.agedPending.length === 0
        ? null
        : Math.max(...summary.agedPending.map((entry) => entry.oldestAgeSeconds));
    writer("megapot.rewards.cycle", {
      event: "megapot.rewards.cycle",
      schema_version: 3,
      emitted_at: input.emittedAt,
      environment: input.environment,
      worker_version_id: input.workerVersion.id,
      worker_version_tag: input.workerVersion.tag,
      worker_version_created_at: input.workerVersion.timestamp,
      duration_ms: input.durationMs,
      reconciled_count: summary.reconciled,
      observed_count: summary.observed,
      frozen_count: summary.frozen,
      committed_count: summary.committed,
      purchased_count: summary.purchased,
      swept_count: summary.swept,
      claimed_count: summary.claimed,
      allocated_count: summary.allocated,
      terminal_offer_count: summary.terminalOffers,
      refunded_count: summary.refunded,
      paid_count: summary.paid,
      failure_count: summary.failures.length,
      failure_tags: summary.failures,
      failure_diagnostics: summary.failureDiagnostics,
      liveness_status: livenessAvailable ? "available" : "unavailable",
      aged_pending_threshold_seconds: MEGAPOT_REWARDS_AGED_PENDING_THRESHOLD_SECONDS,
      aged_pending_total_count: agedTotal,
      aged_chain_effect_count:
        summary.agedPending === null
          ? null
          : agedPendingCount(summary.agedPending, "chain_effects"),
      aged_funding_effect_count:
        summary.agedPending === null
          ? null
          : agedPendingCount(summary.agedPending, "funding_effects"),
      aged_drawing_count:
        summary.agedPending === null ? null : agedPendingCount(summary.agedPending, "drawings"),
      aged_credit_count:
        summary.agedPending === null ? null : agedPendingCount(summary.agedPending, "credits"),
      aged_refund_liability_count:
        summary.agedPending === null
          ? null
          : agedPendingCount(summary.agedPending, "refund_liabilities"),
      oldest_aged_pending_seconds: oldestAgedPendingSeconds,
      outcome:
        summary.failures.length === 0 && livenessAvailable && agedTotal === 0
          ? "healthy"
          : "degraded",
      sampled: false,
    });
    return true;
  } catch {
    return false;
  }
}

function failureTag(error: unknown): string {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = error._tag;
    if (typeof tag === "string" && tag.length > 0) return tag;
  }
  return "MegapotRewardsCycleExpectedFailure";
}

function memberOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): value is Values[number] {
  return typeof value === "string" && values.includes(value);
}

function failureDiagnostic(error: unknown): string | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("_tag" in error) ||
    error._tag !== "RewardRefundCoordinatorFailed" ||
    !("reason" in error) ||
    !memberOf(error.reason, REFUND_COORDINATOR_FAILURE_REASONS) ||
    !("phase" in error) ||
    !memberOf(error.phase, REFUND_COORDINATOR_FAILURE_PHASES)
  ) {
    return null;
  }
  return `${error._tag}:${error.phase}:${error.reason}`;
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
    const failureDiagnostics: string[] = [];
    const recordFailures = (values: readonly unknown[]) => {
      failures.push(...values.map(failureTag));
      failureDiagnostics.push(
        ...values.flatMap((error) => {
          const diagnostic = failureDiagnostic(error);
          return diagnostic === null ? [] : [diagnostic];
        }),
      );
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
        const purchase = yield* input.runtime.purchase(work);
        return purchase.kind !== "closed";
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

    const agedPending = yield* input.work
      .loadAgedPending(MEGAPOT_REWARDS_AGED_PENDING_THRESHOLD_SECONDS)
      .pipe(Effect.catch(() => Effect.succeed(null)));

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
      failureDiagnostics,
      agedPending,
    };
  });
}
