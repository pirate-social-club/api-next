import type { Bytes32, CommunityPurchaseOperationId } from "@pirate/domain";
import { Data, Effect } from "effect";
import type {
  CommunityPurchaseFundingJournalRecord,
  CommunityPurchaseFundingStorageFailed,
} from "./community-purchase-funding.ts";
import type { CommunityPurchaseFundingObservationUseCase } from "./community-purchase-funding-observation.ts";

export type CommunityPurchaseFundingReconcilable = Readonly<{
  readonly operationId: CommunityPurchaseOperationId;
  readonly transactionHash: Bytes32;
}>;

export interface CommunityPurchaseFundingQueryStore {
  readonly loadForActor: (input: {
    readonly operationId: CommunityPurchaseOperationId;
    readonly actorId: string;
  }) => Effect.Effect<
    CommunityPurchaseFundingJournalRecord | null,
    CommunityPurchaseFundingStorageFailed
  >;
  readonly listReconcilable: (input: {
    readonly limit: number;
  }) => Effect.Effect<
    readonly CommunityPurchaseFundingReconcilable[],
    CommunityPurchaseFundingStorageFailed
  >;
}

export class CommunityPurchaseFundingQueryRejected extends Data.TaggedError(
  "CommunityPurchaseFundingQueryRejected",
)<{ readonly reason: "invalid-input" | "not-found" }> {}

export const getCommunityPurchaseFundingForActor = Effect.fn("getCommunityPurchaseFundingForActor")(
  function* (
    input: { readonly operationId: string; readonly actorId: string },
    store: CommunityPurchaseFundingQueryStore,
  ) {
    if (
      input.operationId.length === 0 ||
      input.operationId.trim() !== input.operationId ||
      input.actorId.length === 0 ||
      input.actorId.trim() !== input.actorId
    ) {
      return yield* new CommunityPurchaseFundingQueryRejected({ reason: "invalid-input" });
    }
    const record = yield* store.loadForActor({
      operationId: input.operationId as CommunityPurchaseOperationId,
      actorId: input.actorId,
    });
    if (record === null) {
      return yield* new CommunityPurchaseFundingQueryRejected({ reason: "not-found" });
    }
    return record;
  },
);

export const listReconcilableCommunityPurchaseFunding = Effect.fn(
  "listReconcilableCommunityPurchaseFunding",
)(function* (limit: number, store: CommunityPurchaseFundingQueryStore) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return yield* new CommunityPurchaseFundingQueryRejected({ reason: "invalid-input" });
  }
  return yield* store.listReconcilable({ limit });
});

/** Bounded scheduled composition; it reuses the exact request-path observer. */
export function makeCommunityPurchaseFundingReconciler(
  store: CommunityPurchaseFundingQueryStore,
  observation: CommunityPurchaseFundingObservationUseCase,
) {
  return Effect.fn("reconcileCommunityPurchaseFunding")(function* (input: {
    readonly limit: number;
    readonly ownerId: string;
    readonly leaseMs: number;
    readonly at: number;
  }) {
    if (input.ownerId.length === 0 || input.ownerId.trim() !== input.ownerId) {
      return yield* new CommunityPurchaseFundingQueryRejected({ reason: "invalid-input" });
    }
    const candidates = yield* listReconcilableCommunityPurchaseFunding(input.limit, store);
    let processed = 0;
    for (const candidate of candidates) {
      yield* observation.observe({
        operationId: candidate.operationId,
        transactionHash: candidate.transactionHash,
        ownerId: `${input.ownerId}:${candidate.operationId}`,
        leaseMs: input.leaseMs,
        source: "reconciler",
        at: input.at,
      });
      processed += 1;
    }
    return { selected: candidates.length, processed };
  });
}
