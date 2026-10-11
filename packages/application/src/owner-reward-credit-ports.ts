import type {
  GuestParticipationProjectionV1,
  GuestParticipationResultV1,
  OwnerRewardCreditV1,
} from "@pirate/contracts";
import type { Effect } from "effect";
import type {
  DurableParticipationOutcome,
  GuestParticipationStoreFailure,
  OrdinaryBrowserAccount,
  ParticipationOperationIdentity,
  ParticipationSource,
} from "./guest-participation-authority.ts";

declare const finalizationScope: unique symbol;
/** Opaque live capability issued by the finalization owner. It exposes no SQL/DB/acquisition.
 * Platform keeps the actual transaction private and rejects foreign, expired or mismatched
 * capability identity before admission. It cannot begin, commit or nest a transaction here.
 */
export interface ParticipationFinalizationScope {
  readonly [finalizationScope]: true;
  readonly operation: ParticipationOperationIdentity;
  readonly source: ParticipationSource;
  readonly originalDrawingId: string;
}
type Result<A> = Effect.Effect<A, GuestParticipationStoreFailure>;
export interface ParticipationAdmissionStore {
  readonly admitInTransaction: (
    input: Readonly<{
      scope: ParticipationFinalizationScope;
      qualificationId: string;
      poolLegId: string;
      policyVersionId: string;
      policyHash: string;
      termsHash: string;
      eligibilityDecisionId: string;
      disclosureVersion: string;
    }>,
  ) => Result<
    | Extract<GuestParticipationResultV1, { readonly state: "admitted" }>
    | Readonly<{ state: "already_participating" | "entry_closed" | "ineligible" | "unavailable" }>
  >;
}
/** The finalization owner owns COMMIT and passes certainty through these durable outcomes. */
export interface ParticipationAdmissionReconciliationStore {
  readonly find: (
    input: Readonly<{ operation: ParticipationOperationIdentity; originalDrawingId: string }>,
  ) => Result<
    | Readonly<{ state: "pending_confirmation"; projection: GuestParticipationProjectionV1 }>
    | DurableParticipationOutcome<GuestParticipationResultV1>
  >;
  readonly resolve: (
    input: Readonly<{ operation: ParticipationOperationIdentity; originalDrawingId: string }>,
  ) => Result<DurableParticipationOutcome<GuestParticipationResultV1>>;
}
export type OwnerRewardCreditAuthority =
  | Readonly<{
      kind: "account_owner";
      ownerId: string;
      accountId: string;
      originalPersonaId: string;
      credit: OwnerRewardCreditV1;
    }>
  | Readonly<{
      kind: "guest_owner";
      ownerId: string;
      boundAccountId: string;
      credit: OwnerRewardCreditV1;
    }>;
export interface OwnerRewardCreditStore {
  readonly resolveAuthority: (
    input: Readonly<{ account: OrdinaryBrowserAccount; creditId: string }>,
  ) => Result<OwnerRewardCreditAuthority | null>;
}
export interface RewardCreditRecipientStore {
  /** Guest-owner only. Exact-community active owned persona, append-only pending revision. */
  readonly select: (
    input: Readonly<{
      account: OrdinaryBrowserAccount;
      creditId: string;
      personaId: string;
      operation: ParticipationOperationIdentity;
    }>,
  ) => Result<DurableParticipationOutcome<OwnerRewardCreditV1>>;
}
export type OwnerRewardCreditClaimResult = Readonly<{
  outcome:
    | "accepted"
    | "subject_conflict"
    | "verification_missing"
    | "verification_stale"
    | "verification_failed"
    | "not_claimable";
  credit: OwnerRewardCreditV1;
}>;
export interface OwnerRewardCreditClaimStore {
  /** Derived source branch: NULL original account persona, or exact positive guest revision.
   * Existing subject/Very decision and first immutable binding commit atomically.
   */
  readonly claim: (
    input: Readonly<{
      account: OrdinaryBrowserAccount;
      creditId: string;
      selectionRevision: number | null;
      operation: ParticipationOperationIdentity;
    }>,
  ) => Result<DurableParticipationOutcome<OwnerRewardCreditClaimResult>>;
  readonly operatorAccept: (
    input: Readonly<{
      operator: Readonly<{ subject: string; scope: "rewards:claims" }>;
      creditId: string;
      recordedSelectionRevision: number | null;
      exceptionAuditId: string;
    }>,
  ) => Result<DurableParticipationOutcome<OwnerRewardCreditClaimResult>>;
}
export interface OwnerRewardRecipientResolver {
  /** Retired/unavailable bound persona holds liability; gas uses the actual confirmed payout wallet. */
  readonly resolve: (
    input: Readonly<{ creditId: string }>,
  ) => Result<
    | Readonly<{ state: "bound"; personaId: string; walletAddress: string }>
    | Readonly<{ state: "held"; reason: "unbound" | "persona_unavailable" | "wallet_unavailable" }>
  >;
}
