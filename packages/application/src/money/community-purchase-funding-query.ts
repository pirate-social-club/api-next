import type { Bytes32, CommunityPurchaseOperationId } from "@pirate/domain";
import { Data, Effect } from "effect";
import type {
  CommunityPurchaseFundingJournalRecord,
  CommunityPurchaseFundingStorageFailed,
} from "./community-purchase-funding.ts";

export type CommunityPurchaseFundingReconcilable = Readonly<{
  readonly operationId: CommunityPurchaseOperationId;
  readonly transactionHash: Bytes32;
}>;

/** Bounded non-paging operator report over parked legacy-ambiguous entries. */
export type CommunityPurchaseFundingParkedCount = Readonly<{
  readonly failureTag: "ambiguous" | "legacy";
  readonly failureReason: string;
  readonly operations: number;
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
  readonly parkedCounts: () => Effect.Effect<
    readonly CommunityPurchaseFundingParkedCount[],
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

/** Bounded parked-entry counts for operator visibility; never pages. */
export const parkedCommunityPurchaseFundingCounts = Effect.fn(
  "parkedCommunityPurchaseFundingCounts",
)(function* (store: CommunityPurchaseFundingQueryStore) {
  return yield* store.parkedCounts();
});
