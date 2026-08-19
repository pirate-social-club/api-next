import type { CommunityPurchaseAtomicAmount, EvmAddress } from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";

import { normalizeCommunityPurchaseEvmAddress } from "./community-purchase-funding.ts";
import type { CommunityPurchaseFundingPlanRecord } from "./community-purchase-funding-plan.ts";

/**
 * Internal producer input. It identifies a purchase intent and a previously
 * completed verification; it contains no price, route, allocation, or other
 * browser-authored economic term.
 */
export const CommunityPurchaseQuoteInput = Schema.Struct({
  actorId: Schema.String,
  communityId: Schema.String,
  listingId: Schema.String,
  authenticatedWalletAddress: Schema.String,
  verificationSnapshotId: Schema.String,
  idempotencyKey: Schema.String,
});
export type CommunityPurchaseQuoteInput = Schema.Schema.Type<typeof CommunityPurchaseQuoteInput>;

export type CommunityPurchaseQuote = Readonly<{
  readonly quoteId: string;
  readonly purchaseId: string;
  readonly communityId: string;
  readonly listingId: string;
  readonly policyVersion: number;
  readonly buyerWalletAddress: EvmAddress;
  readonly expectedChainId: number;
  readonly tokenContract: EvmAddress;
  readonly tokenDecimals: 6;
  readonly treasuryAddress: EvmAddress;
  readonly amountAtomic: CommunityPurchaseAtomicAmount;
  readonly requiredConfirmations: number;
  readonly quotedAt: string;
  readonly expiresAt: string;
  readonly plan: CommunityPurchaseFundingPlanRecord;
}>;

export type CommunityPurchaseQuoteCreateOutcome =
  | { readonly kind: "inserted"; readonly quote: CommunityPurchaseQuote }
  | { readonly kind: "replayed"; readonly quote: CommunityPurchaseQuote }
  | { readonly kind: "not_found" }
  | { readonly kind: "conflict" };

export class CommunityPurchaseCommerceStorageFailed extends Data.TaggedError(
  "CommunityPurchaseCommerceStorageFailed",
)<{
  readonly reason: "unavailable" | "invalid-row" | "constraint" | "outcome-unknown";
}> {}

export interface CommunityPurchaseCommerceStore {
  readonly createQuoteAndPlan: (input: {
    readonly actorId: string;
    readonly communityId: string;
    readonly listingId: string;
    readonly authenticatedWalletAddress: EvmAddress;
    readonly verificationSnapshotId: string;
    readonly idempotencyKey: string;
  }) => Effect.Effect<CommunityPurchaseQuoteCreateOutcome, CommunityPurchaseCommerceStorageFailed>;
}

export class CommunityPurchaseQuoteRejected extends Data.TaggedError(
  "CommunityPurchaseQuoteRejected",
)<{ readonly reason: "invalid-input" | "not-found" | "conflict" }> {}

export type CommunityPurchaseQuoteFailure =
  | CommunityPurchaseQuoteRejected
  | CommunityPurchaseCommerceStorageFailed;

function canonicalId(value: string): boolean {
  return value.length > 0 && value === value.trim() && !value.includes("\u0000");
}

function canonicalWallet(value: string): EvmAddress | null {
  return normalizeCommunityPurchaseEvmAddress(value);
}

/**
 * Creates a server-derived quote and immutable funding plan. The producer is
 * not a public transport handler; callers must supply authenticated identity
 * and a verification snapshot, while the store derives every economic term.
 */
export const createCommunityPurchaseQuote = Effect.fn("createCommunityPurchaseQuote")(function* (
  rawInput: unknown,
  store: CommunityPurchaseCommerceStore,
): Effect.fn.Return<CommunityPurchaseQuote, CommunityPurchaseQuoteFailure> {
  const decoded = Schema.decodeUnknownOption(CommunityPurchaseQuoteInput)(rawInput);
  if (Option.isNone(decoded)) {
    return yield* new CommunityPurchaseQuoteRejected({ reason: "invalid-input" });
  }
  const input = decoded.value;
  const wallet = canonicalWallet(input.authenticatedWalletAddress);
  if (
    !canonicalId(input.actorId) ||
    !canonicalId(input.communityId) ||
    !canonicalId(input.listingId) ||
    !canonicalId(input.verificationSnapshotId) ||
    !canonicalId(input.idempotencyKey) ||
    wallet === null
  ) {
    return yield* new CommunityPurchaseQuoteRejected({ reason: "invalid-input" });
  }
  const outcome = yield* store.createQuoteAndPlan({
    actorId: input.actorId,
    communityId: input.communityId,
    listingId: input.listingId,
    authenticatedWalletAddress: wallet,
    verificationSnapshotId: input.verificationSnapshotId,
    idempotencyKey: input.idempotencyKey,
  });
  if (outcome.kind === "not_found") {
    return yield* new CommunityPurchaseQuoteRejected({ reason: "not-found" });
  }
  if (outcome.kind === "conflict") {
    return yield* new CommunityPurchaseQuoteRejected({ reason: "conflict" });
  }
  return outcome.quote;
});

export function makeCommunityPurchaseQuoteUseCase(store: CommunityPurchaseCommerceStore) {
  return (input: unknown) => createCommunityPurchaseQuote(input, store);
}
