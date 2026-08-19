import {
  COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
  type CommunityPurchaseOperationId,
  nextReconciliationAttemptDelayMs,
  type ReconciliationBackoffPolicy,
  type ReconciliationFailureClass,
} from "@pirate/domain";
import { Effect } from "effect";
import type { Alert } from "../ports.ts";
import type { CommunityPurchaseFundingStorageFailed } from "./community-purchase-funding.ts";
import type {
  CommunityPurchaseFundingObservationFailure,
  CommunityPurchaseFundingObservationUseCase,
} from "./community-purchase-funding-observation.ts";
import {
  CommunityPurchaseFundingQueryRejected,
  type CommunityPurchaseFundingQueryStore,
  listReconcilableCommunityPurchaseFunding,
} from "./community-purchase-funding-query.ts";

/** Durable scheduling state; never an economic identity or journal fence. */
export type CommunityPurchaseFundingAttemptState = Readonly<{
  readonly operationId: CommunityPurchaseOperationId;
  readonly generation: number;
  /** The claim generation whose finalizer has already been consumed, if any. */
  readonly finalizedGeneration: number | null;
  readonly lastAttemptAt: string | null;
  readonly nextAttemptAt: string | null;
  readonly lastFailureClass: ReconciliationFailureClass | null;
  readonly consecutiveFailures: number;
  readonly escalatedAt: string | null;
}>;

export type CommunityPurchaseFundingAttemptReservation = Readonly<
  | { readonly kind: "reserved"; readonly state: CommunityPurchaseFundingAttemptState }
  | { readonly kind: "unavailable" }
>;

export type CommunityPurchaseFundingAttemptFinalization = Readonly<
  | { readonly kind: "finalized"; readonly state: CommunityPurchaseFundingAttemptState }
  | { readonly kind: "stale" }
>;

export type CommunityPurchaseFundingAttemptReset = Readonly<
  { readonly kind: "reset"; readonly generation: number } | { readonly kind: "not-escalated" }
>;

/** Coordinator-only recovery seam; it never creates a claim or advances generation. */
export interface CommunityPurchaseFundingReconciliationOperatorStore {
  readonly resetEscalatedAttempt: (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly actorId: string;
    readonly reason: string;
  }) => Effect.Effect<CommunityPurchaseFundingAttemptReset, CommunityPurchaseFundingStorageFailed>;
}

export interface CommunityPurchaseFundingReconciliationAttemptStore {
  /** Claim only if absent, due, and non-escalated; generation fences every write. */
  readonly recordAttemptStart: (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly reservationMs: number;
  }) => Effect.Effect<
    CommunityPurchaseFundingAttemptReservation,
    CommunityPurchaseFundingStorageFailed
  >;
  readonly recordAttemptSuccess: (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly generation: number;
  }) => Effect.Effect<
    CommunityPurchaseFundingAttemptFinalization,
    CommunityPurchaseFundingStorageFailed
  >;
  readonly recordAttemptFailure: (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly generation: number;
    readonly failureClass: ReconciliationFailureClass;
    readonly retryDelayMs: number;
    readonly escalationThreshold: number;
  }) => Effect.Effect<
    CommunityPurchaseFundingAttemptFinalization,
    CommunityPurchaseFundingStorageFailed
  >;
}

export type CommunityPurchaseFundingObservationClassification = Readonly<
  | { readonly kind: "expected"; readonly failureClass: ReconciliationFailureClass }
  | { readonly kind: "defect" }
>;

export function classifyObservationFailure(
  error: CommunityPurchaseFundingObservationFailure,
): CommunityPurchaseFundingObservationClassification {
  if (error._tag === "CommunityPurchaseFundingChainReadFailed") {
    switch (error.reason) {
      case "timeout":
        return { kind: "expected", failureClass: "chain_timeout" };
      case "unavailable":
        return { kind: "expected", failureClass: "chain_unavailable" };
      case "not-found":
        return { kind: "expected", failureClass: "transaction_not_found" };
      case "invalid-evidence":
        return { kind: "expected", failureClass: "invalid_evidence" };
      case "reorg":
        return { kind: "expected", failureClass: "reorg" };
    }
  }
  if (error._tag === "CommunityPurchaseFundingRejected") {
    switch (error.reason) {
      case "lease-busy":
      case "lease-lost":
      case "version-conflict":
      case "transition-rejected":
        return { kind: "expected", failureClass: "lease_contention" };
      case "identity-conflict":
        return { kind: "expected", failureClass: "identity_conflict" };
      default:
        return { kind: "defect" };
    }
  }
  return { kind: "defect" };
}

export const COMMUNITY_PURCHASE_RECONCILIATION_STUCK_ALERT_KEY =
  "money.community-purchase-funding.reconciler.stuck";

export type CommunityPurchaseFundingReconciliationResult = Readonly<{
  readonly selected: number;
  readonly processed: number;
  readonly failed: number;
  readonly skipped: number;
}>;

export interface CommunityPurchaseFundingReconciliationAlerts {
  readonly emit: (alert: Alert) => Effect.Effect<void>;
}

/**
 * The candidate list is due/backoff-aware, but claims remain conditional in
 * Postgres because two workers may select the same due operation. A claim
 * loser never reaches the chain reader. The journal lease/fence remains the
 * economic transition fence; this table only fences retry metadata.
 */
export function makeCommunityPurchaseFundingReconciler(
  store: CommunityPurchaseFundingQueryStore,
  attempts: CommunityPurchaseFundingReconciliationAttemptStore,
  observation: CommunityPurchaseFundingObservationUseCase,
  alerts: CommunityPurchaseFundingReconciliationAlerts,
  policy: ReconciliationBackoffPolicy = COMMUNITY_PURCHASE_RECONCILIATION_BACKOFF,
) {
  return Effect.fn("reconcileCommunityPurchaseFunding")(function* (input: {
    readonly limit: number;
    readonly ownerId: string;
    readonly leaseMs: number;
    readonly reservationMs?: number;
  }) {
    if (input.ownerId.length === 0 || input.ownerId.trim() !== input.ownerId) {
      return yield* new CommunityPurchaseFundingQueryRejected({ reason: "invalid-input" });
    }
    const candidates = yield* listReconcilableCommunityPurchaseFunding(input.limit, store);
    let processed = 0;
    let failed = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const reservation = yield* attempts.recordAttemptStart({
        operationId: candidate.operationId,
        reservationMs: input.reservationMs ?? input.leaseMs,
      });
      if (reservation.kind === "unavailable") {
        skipped += 1;
        continue;
      }
      const outcome = yield* Effect.result(
        observation.observe({
          operationId: candidate.operationId,
          transactionHash: candidate.transactionHash,
          ownerId: `${input.ownerId}:${candidate.operationId}`,
          leaseMs: input.leaseMs,
          source: "reconciler",
        }),
      );
      if (outcome._tag === "Success") {
        const recorded = yield* attempts.recordAttemptSuccess({
          operationId: candidate.operationId,
          generation: reservation.state.generation,
        });
        if (recorded.kind === "stale") {
          skipped += 1;
          continue;
        }
        processed += 1;
        continue;
      }
      const classification = classifyObservationFailure(outcome.failure);
      if (classification.kind === "defect") return yield* Effect.fail(outcome.failure);
      const retryDelayMs = nextReconciliationAttemptDelayMs({
        failureClass: classification.failureClass,
        consecutiveFailures: reservation.state.consecutiveFailures + 1,
        operationId: candidate.operationId,
        policy,
      });
      const recorded = yield* attempts.recordAttemptFailure({
        operationId: candidate.operationId,
        generation: reservation.state.generation,
        failureClass: classification.failureClass,
        retryDelayMs,
        escalationThreshold: policy.escalationThreshold,
      });
      if (recorded.kind === "stale") {
        skipped += 1;
        continue;
      }
      failed += 1;
      if (recorded.state.consecutiveFailures === policy.escalationThreshold) {
        yield* alerts.emit({
          key: COMMUNITY_PURCHASE_RECONCILIATION_STUCK_ALERT_KEY,
          severity: "high",
          body: `community purchase funding reconciliation stuck after ${recorded.state.consecutiveFailures} consecutive failures (class: ${classification.failureClass}); operator review required`,
          entity: candidate.operationId,
        });
      }
    }
    return { selected: candidates.length, processed, failed, skipped };
  });
}
