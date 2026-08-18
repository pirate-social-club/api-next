import type { CommunityPurchaseOperationId } from "@pirate/domain";
import { Effect } from "effect";
import {
  type CommunityPurchaseFundingCaller,
  type CommunityPurchaseFundingInterpreter,
  type CommunityPurchaseFundingInterpreterFailure,
  type CommunityPurchaseFundingJournalRecord,
  CommunityPurchaseFundingRejected,
  CommunityPurchaseFundingStorageFailed,
} from "./community-purchase-funding.ts";

/**
 * Server-owned deadline for silent-checkout expiry. The platform locks the
 * bound plan row and reads the Postgres clock in the same transaction, so the
 * deadline and the "now" it is compared against can never come from a browser,
 * a worker clock, or a cached read.
 */
export type CommunityPurchaseFundingPlanExpiry = Readonly<{
  readonly observationDeadlineMs: number;
  readonly databaseNowMs: number;
}>;

export interface CommunityPurchaseFundingExpiryStore {
  readonly readPlanExpiry: (input: {
    readonly operationId: CommunityPurchaseOperationId;
  }) => Effect.Effect<
    CommunityPurchaseFundingPlanExpiry | null,
    CommunityPurchaseFundingStorageFailed
  >;
}

export type CommunityPurchaseFundingExpiryResult = Readonly<
  | { readonly kind: "expired"; readonly entry: CommunityPurchaseFundingJournalRecord["entry"] }
  | { readonly kind: "not_due"; readonly entry: CommunityPurchaseFundingJournalRecord["entry"] }
  | {
      readonly kind: "not_planned";
      readonly entry: CommunityPurchaseFundingJournalRecord["entry"];
    }
>;

export type CommunityPurchaseFundingExpiryFailure =
  | CommunityPurchaseFundingInterpreterFailure
  | CommunityPurchaseFundingStorageFailed;

/**
 * Parks a silent planned operation as legacy-ambiguous. The scheduled caller
 * only identifies candidates; the reducer remains the sole lifecycle
 * authority. No quote release, no retry metadata, no RPC selection, and no
 * terminal or reclaimable claim happens here.
 */
export function makeCommunityPurchaseFundingExpiryUseCase(
  interpreter: CommunityPurchaseFundingInterpreter,
  store: CommunityPurchaseFundingExpiryStore,
) {
  return Effect.fn("CommunityPurchaseFundingExpiry.expireIfDue")(function* (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly ownerId: string;
    readonly leaseMs: number;
    readonly source: CommunityPurchaseFundingCaller;
  }) {
    const lease = yield* interpreter.acquireLease({
      operationId: input.operationId,
      ownerId: input.ownerId,
      leaseMs: input.leaseMs,
    });
    const loaded = yield* interpreter.load(input.operationId);
    if (loaded === null) {
      return yield* new CommunityPurchaseFundingRejected({ reason: "not-found" });
    }
    if (loaded.entry.state.state !== "planned") {
      return { kind: "not_planned", entry: loaded.entry } as const;
    }
    const expiry = yield* store.readPlanExpiry({ operationId: input.operationId });
    if (expiry === null) {
      // Admission binds the plan and journal atomically; a planned operation
      // without its bound plan is a storage defect, never a caller outcome.
      return yield* new CommunityPurchaseFundingStorageFailed({ reason: "invalid-row" });
    }
    if (expiry.databaseNowMs < expiry.observationDeadlineMs) {
      return { kind: "not_due", entry: loaded.entry } as const;
    }
    const transitioned = yield* interpreter.transition({
      lease,
      source: input.source,
      expectedVersion: loaded.entry.version,
      event: {
        type: "planned_observation_window_expired",
        expectedVersion: loaded.entry.version,
        at: expiry.databaseNowMs,
        policyVersion: loaded.entry.state.policyVersion,
        observationDeadline: expiry.observationDeadlineMs,
      },
    });
    return { kind: "expired", entry: transitioned.entry } as const;
  });
}

export type CommunityPurchaseFundingExpiryUseCase = ReturnType<
  typeof makeCommunityPurchaseFundingExpiryUseCase
>;
