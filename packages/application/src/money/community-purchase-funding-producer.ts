import type { CommunityPurchaseFundingExpectation, EvmAddress } from "@pirate/domain";
import { Data, Effect } from "effect";
import { normalizeCommunityPurchaseEvmAddress } from "./community-purchase-funding";

/** The only browser-originated commerce intent accepted by the producer. */
export type CommunityPurchaseFundingProducerInput = Readonly<{
  readonly actorId: string;
  readonly authenticatedWalletAddress: string;
  readonly communityId: string;
  readonly listingId: string;
}>;

export type CommunityPurchaseFundingQuoteRecord = Readonly<{
  readonly quoteId: string;
  readonly purchaseId: string;
  readonly communityId: string;
  readonly actorId: string;
  readonly listingId: string;
  readonly policyVersion: number;
  readonly expected: CommunityPurchaseFundingExpectation;
  readonly quotedAt: string;
  readonly expiresAt: string;
}>;

export type CommunityPurchaseFundingQuoteResult = CommunityPurchaseFundingQuoteRecord &
  Readonly<{
    readonly replayed: boolean;
  }>;

export type CommunityPurchaseFundingProducerStoreOutcome =
  | { readonly kind: "created"; readonly quote: CommunityPurchaseFundingQuoteRecord }
  | { readonly kind: "replayed"; readonly quote: CommunityPurchaseFundingQuoteRecord }
  | { readonly kind: "not-found" }
  | { readonly kind: "conflict" };

export class CommunityPurchaseFundingProducerStorageFailed extends Data.TaggedError(
  "CommunityPurchaseFundingProducerStorageFailed",
)<{ readonly reason: "unavailable" | "constraint" | "invalid-row" | "outcome-unknown" }> {}

export interface CommunityPurchaseFundingProducerStore {
  /**
   * Derives all economic terms from target-owned policy and atomically writes
   * the quote, availability reservation, and immutable funding plan. This
   * port must never accept browser-authored economics.
   */
  readonly createQuoteAndPlan: (
    input: Readonly<{
      readonly actorId: string;
      readonly buyerWalletAddress: EvmAddress;
      readonly communityId: string;
      readonly listingId: string;
      readonly quoteTtlSeconds: 600;
    }>,
  ) => Effect.Effect<
    CommunityPurchaseFundingProducerStoreOutcome,
    CommunityPurchaseFundingProducerStorageFailed
  >;
}

export class CommunityPurchaseFundingProducerRejected extends Data.TaggedError(
  "CommunityPurchaseFundingProducerRejected",
)<{
  readonly reason: "invalid-input" | "not-found" | "conflict";
}> {}

const usableId = (value: string): boolean =>
  value.length > 0 && value === value.trim() && !value.includes("\u0000");

/**
 * Target-owned quote producer. The request contains intent only; policy and
 * economic terms enter through the storage port's atomic source transaction.
 */
export const produceCommunityPurchaseFundingQuote = Effect.fn(
  "produceCommunityPurchaseFundingQuote",
)(function* (
  input: CommunityPurchaseFundingProducerInput,
  store: CommunityPurchaseFundingProducerStore,
): Effect.fn.Return<
  CommunityPurchaseFundingQuoteResult,
  CommunityPurchaseFundingProducerRejected | CommunityPurchaseFundingProducerStorageFailed
> {
  if (!usableId(input.actorId) || !usableId(input.communityId) || !usableId(input.listingId)) {
    return yield* new CommunityPurchaseFundingProducerRejected({ reason: "invalid-input" });
  }
  const wallet = normalizeCommunityPurchaseEvmAddress(input.authenticatedWalletAddress);
  if (wallet === null) {
    return yield* new CommunityPurchaseFundingProducerRejected({ reason: "invalid-input" });
  }
  const outcome = yield* store.createQuoteAndPlan({
    actorId: input.actorId,
    buyerWalletAddress: wallet,
    communityId: input.communityId,
    listingId: input.listingId,
    quoteTtlSeconds: 600,
  });
  if (outcome.kind === "not-found") {
    return yield* new CommunityPurchaseFundingProducerRejected({ reason: "not-found" });
  }
  if (outcome.kind === "conflict") {
    return yield* new CommunityPurchaseFundingProducerRejected({ reason: "conflict" });
  }
  return {
    ...outcome.quote,
    replayed: outcome.kind === "replayed",
  };
});
