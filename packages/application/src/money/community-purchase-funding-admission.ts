import type {
  CommunityPurchaseFundingSnapshot,
  EvmAddress,
  MoneyFlowJournalEntry,
} from "@pirate/domain";
import { Data, Effect, Option, Schema } from "effect";
import {
  COMMUNITY_PURCHASE_FUNDING_ENDPOINT,
  type CommunityPurchaseFundingJournalRecord,
  CommunityPurchaseFundingStorageFailed,
  computeCommunityPurchaseFundingRequestHash,
  normalizeCommunityPurchaseEvmAddress,
} from "./community-purchase-funding.ts";

/** The only fields accepted by the public funding-admission use case. */
export const CommunityPurchaseFundingAdmissionInput = Schema.Struct({
  actorId: Schema.String,
  authenticatedWalletAddress: Schema.String,
  quoteId: Schema.String,
  clientNonce: Schema.String,
});
export type CommunityPurchaseFundingAdmissionInput = Schema.Schema.Type<
  typeof CommunityPurchaseFundingAdmissionInput
>;

/** Versioned, server-authored request document; it contains no economic terms. */
export type CommunityPurchaseFundingAdmissionCanonicalRequest = Readonly<{
  readonly request_version: "community-purchase-funding-admission-v1";
  readonly quote_id: string;
  readonly wallet_address: EvmAddress;
}>;

export type CommunityPurchaseFundingAdmissionStoreOutcome =
  | { readonly kind: "inserted"; readonly record: CommunityPurchaseFundingJournalRecord }
  | { readonly kind: "replayed"; readonly record: CommunityPurchaseFundingJournalRecord }
  | { readonly kind: "request_conflict" }
  | { readonly kind: "operation_conflict" }
  | { readonly kind: "plan_not_found" }
  | { readonly kind: "plan_expired" }
  | { readonly kind: "plan_cancelled" }
  | { readonly kind: "actor_mismatch" }
  | { readonly kind: "wallet_mismatch" };

export type CommunityPurchaseFundingAdmissionStoreInput = Readonly<{
  readonly actorId: string;
  readonly authenticatedWalletAddress: EvmAddress;
  readonly quoteId: string;
  readonly clientNonce: string;
  readonly canonicalRequest: CommunityPurchaseFundingAdmissionCanonicalRequest;
  readonly requestHash: string;
}>;

/**
 * Server-owned plan source and atomic admission seam. Implementations lock
 * the quote/plan, validate actor and wallet, derive economic identity, and
 * insert/replay the journal in the same transaction.
 */
export interface CommunityPurchaseFundingPlanSource {
  readonly beginFromPlan: (
    input: CommunityPurchaseFundingAdmissionStoreInput,
  ) => Effect.Effect<
    CommunityPurchaseFundingAdmissionStoreOutcome,
    CommunityPurchaseFundingStorageFailed
  >;
}

/** Naming used by application callers; the concrete platform remains the source. */
export type CommunityPurchaseFundingAdmissionStore = CommunityPurchaseFundingPlanSource;

export type CommunityPurchaseFundingAdmissionResult = Readonly<{
  readonly entry: MoneyFlowJournalEntry<CommunityPurchaseFundingSnapshot>;
  readonly replayed: boolean;
}>;

export class CommunityPurchaseFundingAdmissionRejected extends Data.TaggedError(
  "CommunityPurchaseFundingAdmissionRejected",
)<{
  readonly reason:
    | "invalid-input"
    | "request-conflict"
    | "operation-conflict"
    | "plan-not-found"
    | "plan-expired"
    | "plan-cancelled"
    | "actor-mismatch"
    | "wallet-mismatch";
}> {}

export type CommunityPurchaseFundingAdmissionFailure =
  | CommunityPurchaseFundingAdmissionRejected
  | CommunityPurchaseFundingStorageFailed;

function validCanonicalId(value: string): boolean {
  return value.length > 0 && value === value.trim();
}

function canonicalRequest(
  quoteId: string,
  walletAddress: EvmAddress,
): CommunityPurchaseFundingAdmissionCanonicalRequest {
  return {
    request_version: "community-purchase-funding-admission-v1",
    quote_id: quoteId,
    wallet_address: walletAddress,
  };
}

function outcomeRejection(
  kind: CommunityPurchaseFundingAdmissionStoreOutcome["kind"],
): CommunityPurchaseFundingAdmissionRejected["reason"] | null {
  switch (kind) {
    case "request_conflict":
      return "request-conflict";
    case "operation_conflict":
      return "operation-conflict";
    case "plan_not_found":
      return "plan-not-found";
    case "plan_expired":
      return "plan-expired";
    case "plan_cancelled":
      return "plan-cancelled";
    case "actor_mismatch":
      return "actor-mismatch";
    case "wallet_mismatch":
      return "wallet-mismatch";
    default:
      return null;
  }
}

/** Safe public admission; economic terms and operation identity never enter. */
export const admitCommunityPurchaseFunding = Effect.fn("admitCommunityPurchaseFunding")(function* (
  rawInput: unknown,
  planSource: CommunityPurchaseFundingPlanSource,
): Effect.fn.Return<
  CommunityPurchaseFundingAdmissionResult,
  CommunityPurchaseFundingAdmissionFailure
> {
  const decoded = Schema.decodeUnknownOption(CommunityPurchaseFundingAdmissionInput)(rawInput);
  if (Option.isNone(decoded)) {
    return yield* new CommunityPurchaseFundingAdmissionRejected({ reason: "invalid-input" });
  }
  const input = decoded.value;
  if (
    !validCanonicalId(input.actorId) ||
    !validCanonicalId(input.quoteId) ||
    !validCanonicalId(input.clientNonce)
  ) {
    return yield* new CommunityPurchaseFundingAdmissionRejected({ reason: "invalid-input" });
  }
  const walletAddress = normalizeCommunityPurchaseEvmAddress(input.authenticatedWalletAddress);
  if (walletAddress === null) {
    return yield* new CommunityPurchaseFundingAdmissionRejected({ reason: "invalid-input" });
  }
  const request = canonicalRequest(input.quoteId, walletAddress);
  const requestHash = yield* Effect.tryPromise({
    try: () => computeCommunityPurchaseFundingRequestHash(request),
    catch: () => new CommunityPurchaseFundingStorageFailed({ reason: "unavailable" }),
  });
  const outcome = yield* planSource.beginFromPlan({
    actorId: input.actorId,
    authenticatedWalletAddress: walletAddress,
    quoteId: input.quoteId,
    clientNonce: input.clientNonce,
    canonicalRequest: request,
    requestHash,
  });
  const reason = outcomeRejection(outcome.kind);
  if (reason !== null) return yield* new CommunityPurchaseFundingAdmissionRejected({ reason });
  if (outcome.kind === "inserted" || outcome.kind === "replayed") {
    return { entry: outcome.record.entry, replayed: outcome.kind === "replayed" };
  }
  return yield* new CommunityPurchaseFundingAdmissionRejected({ reason: "invalid-input" });
});

export function makeCommunityPurchaseFundingAdmissionUseCase(
  planSource: CommunityPurchaseFundingPlanSource,
) {
  return (input: unknown) => admitCommunityPurchaseFunding(input, planSource);
}

export { COMMUNITY_PURCHASE_FUNDING_ENDPOINT, CommunityPurchaseFundingStorageFailed };
