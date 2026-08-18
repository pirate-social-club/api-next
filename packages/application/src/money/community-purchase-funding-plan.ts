import type {
  CommunityPurchaseAtomicAmount,
  CommunityPurchaseFundingExpectation,
  EvmAddress,
} from "@pirate/domain";
import { Data, Effect } from "effect";

import type { CommunityPurchaseFundingStorageFailed } from "./community-purchase-funding";

/**
 * Terms already derived and authorized by the owning product domain. This seam
 * validates no price or treasury policy and must never be called from a public
 * request with browser-authored economics.
 */
export type CommunityPurchaseFundingPlanDraft = Readonly<{
  quoteId: string;
  communityId: string;
  actorId: string;
  buyerWalletAddress: EvmAddress;
  buyerChainId: number;
  purchaseId: string;
  policyVersion: number;
  tokenContract: EvmAddress;
  tokenDecimals: 6;
  treasuryAddress: EvmAddress;
  amountAtomic: CommunityPurchaseAtomicAmount;
  requiredConfirmations: number;
  quoteTtlSeconds: number;
}>;

export type CommunityPurchaseFundingPlanRecord = Readonly<{
  quoteId: string;
  communityId: string;
  actorId: string;
  purchaseId: string;
  policyVersion: number;
  expected: CommunityPurchaseFundingExpectation;
  quotedAt: string;
  expiresAt: string;
}>;

export type CommunityPurchaseFundingPlanCreateOutcome =
  | { readonly kind: "inserted"; readonly plan: CommunityPurchaseFundingPlanRecord }
  | { readonly kind: "replayed"; readonly plan: CommunityPurchaseFundingPlanRecord }
  | { readonly kind: "conflict" };

export interface CommunityPurchaseFundingPlanStore {
  readonly createPlan: (
    draft: CommunityPurchaseFundingPlanDraft,
  ) => Effect.Effect<
    CommunityPurchaseFundingPlanCreateOutcome,
    CommunityPurchaseFundingStorageFailed
  >;
}

export class CommunityPurchaseFundingPlanRejected extends Data.TaggedError(
  "CommunityPurchaseFundingPlanRejected",
)<{ readonly reason: "invalid-input" | "conflict" }> {}

function canonicalId(value: string): boolean {
  return value.length > 0 && value === value.trim();
}

function canonicalAddress(value: string): boolean {
  return /^0x[0-9a-f]{40}$/u.test(value);
}

/** Product-internal only: persistence after the owning domain derives terms. */
export const createCommunityPurchaseFundingPlan = Effect.fn("createCommunityPurchaseFundingPlan")(
  function* (draft: CommunityPurchaseFundingPlanDraft, store: CommunityPurchaseFundingPlanStore) {
    if (
      !canonicalId(draft.quoteId) ||
      !canonicalId(draft.communityId) ||
      !canonicalId(draft.actorId) ||
      !canonicalId(draft.purchaseId) ||
      !Number.isSafeInteger(draft.policyVersion) ||
      draft.policyVersion < 1 ||
      !Number.isSafeInteger(draft.buyerChainId) ||
      draft.buyerChainId < 1 ||
      !Number.isSafeInteger(draft.requiredConfirmations) ||
      draft.requiredConfirmations < 1 ||
      !Number.isSafeInteger(draft.quoteTtlSeconds) ||
      draft.quoteTtlSeconds < 1 ||
      draft.quoteTtlSeconds > 3_600 ||
      !canonicalAddress(draft.buyerWalletAddress) ||
      !canonicalAddress(draft.tokenContract) ||
      !canonicalAddress(draft.treasuryAddress) ||
      draft.tokenDecimals !== 6 ||
      typeof draft.amountAtomic !== "bigint" ||
      draft.amountAtomic < 1n
    ) {
      return yield* new CommunityPurchaseFundingPlanRejected({ reason: "invalid-input" });
    }
    const outcome = yield* store.createPlan(draft);
    if (outcome.kind === "conflict") {
      return yield* new CommunityPurchaseFundingPlanRejected({ reason: "conflict" });
    }
    return outcome;
  },
);
