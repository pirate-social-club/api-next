import type {
  GuestAttachmentBindingV1,
  GuestAttachmentIntentV1,
  GuestAttachmentPreparedV1,
  GuestAuthorityV1,
  GuestCleanupAuthorityV1,
  GuestLearningRetentionV1,
  GuestOperationKindV1,
  GuestParticipationProjectionV1,
} from "@pirate/contracts";
import { Data, type Effect } from "effect";
import type { ControlPlaneError } from "./ports.ts";

export type ParticipationSource =
  | Readonly<{ kind: "account"; ownerId: string; accountId: string; personaId: string }>
  | Readonly<{ kind: "guest"; ownerId: string }>;
export type OrdinaryBrowserAccount = Readonly<{
  kind: "ordinary_account";
  accountId: string;
  sessionBinding: string;
}>;
export type SetupBrowserAccount = Readonly<{
  kind: "persona_wallet_setup";
  accountId: string;
  sessionBinding: string;
}>;
export type GuestRecoveryAccess = Readonly<{
  kind: "guest";
  ownerId: string;
  credentialId: string;
  origin: string;
}>;
export type GuestLearningAccess = GuestRecoveryAccess & Readonly<{ leaseUntil: string }>;
export type LearningAccess =
  | GuestLearningAccess
  | Readonly<{ kind: "account"; accountId: string; sessionBinding: string }>;
export type RecoveryAccess =
  | GuestRecoveryAccess
  | Readonly<{ kind: "bound_account"; accountId: string; sessionBinding: string }>;

export type ProvedGuestCredential = Readonly<{
  ownerId: string;
  credentialId: string;
  origin: string;
  state: "pending_bootstrap" | "pending_successor" | "confirmed" | "revoked";
  leaseUntil: string | null;
  pendingExpiresAt: string | null;
  predecessorCredentialId: string | null;
}>;
export type ProvedGuestIntent = Readonly<{
  intentId: string;
  ownerId: string;
  credentialId: string;
  origin: string;
  state: "awaiting_account" | "awaiting_confirmation" | "consumed" | "superseded" | "expired";
  expiresAt: string;
}>;
type BrowserProofContext = Readonly<{
  origin: string;
  provedCredentials: readonly ProvedGuestCredential[];
  provedIntents: readonly ProvedGuestIntent[];
}>;
type UnsafeGuestBrowserContext = BrowserProofContext & Readonly<{ originAndCsrfChecked: true }>;
type ConfirmedGuestProof = ProvedGuestCredential & Readonly<{ state: "confirmed" }>;

/** Candidate proof disposes only locked empty/terminal candidates; it is not recovery access. */
export type CleanupDispositionContext = UnsafeGuestBrowserContext &
  Readonly<{
    authority: "recovery";
    operation: "cleanup";
    selected: ProvedGuestCredential | null;
  }>;
export type BrowserParticipationContext =
  | (BrowserProofContext &
      Readonly<{
        authority: "bootstrap";
        operation: "discover";
        selected: ProvedGuestCredential | null;
      }>)
  | (UnsafeGuestBrowserContext &
      Readonly<{
        authority: "bootstrap";
        operation: "issue";
        selected: ProvedGuestCredential | null;
      }>)
  | (UnsafeGuestBrowserContext &
      Readonly<{
        authority: "bootstrap";
        operation: "confirm";
        selected: ProvedGuestCredential & { readonly state: "pending_bootstrap" | "confirmed" };
      }>)
  | (UnsafeGuestBrowserContext &
      Readonly<{
        authority: "recovery";
        operation: "renew" | "rotate" | "create_attachment_intent";
        selected: ConfirmedGuestProof;
        access: GuestRecoveryAccess;
      }>)
  | (UnsafeGuestBrowserContext &
      Readonly<{
        authority: "recovery";
        operation: "acknowledge";
        selected: ProvedGuestCredential & {
          readonly state: "pending_successor" | "confirmed";
          readonly predecessorCredentialId: string;
        };
      }>)
  | CleanupDispositionContext
  | (BrowserProofContext &
      Readonly<{ authority: "recovery"; operation: "participations"; access: RecoveryAccess }>)
  | (UnsafeGuestBrowserContext &
      Readonly<{
        authority: "recovery";
        operation: "retention" | "delete_audio";
        access: RecoveryAccess;
      }>)
  | (UnsafeGuestBrowserContext &
      Readonly<{
        authority: "learning";
        operation: "start";
        selected: ConfirmedGuestProof;
        access: GuestLearningAccess;
      }>)
  | (BrowserProofContext &
      Readonly<{
        authority: "learning";
        operation: "read" | "operation_result";
        access: LearningAccess;
      }>)
  | (UnsafeGuestBrowserContext &
      Readonly<{ authority: "learning"; operation: "answer"; access: LearningAccess }>)
  | (UnsafeGuestBrowserContext &
      Readonly<{
        authority: "attachment";
        operation: "prepare_target" | "confirm_target";
        selected: ConfirmedGuestProof;
        access: GuestRecoveryAccess;
        account: OrdinaryBrowserAccount | SetupBrowserAccount;
        accountCsrfChecked: true;
        intent: ProvedGuestIntent & {
          readonly state: "awaiting_account" | "awaiting_confirmation";
        };
      }>);
export type ParticipationOperationIdentity = Readonly<{
  sourceOwnerId: string;
  kind: GuestOperationKindV1;
  idempotencyKey: string;
  requestHash: string;
}>;
/** Known abort requires authoritative serialization, never merely a missing row. */
export type DurableParticipationOutcome<A> =
  | Readonly<{
      state: "completed";
      operation: ParticipationOperationIdentity;
      outcomeId: string;
      result: A;
    }>
  | Readonly<{
      state: "pending_confirmation";
      operation: ParticipationOperationIdentity;
      outcomeId: string | null;
    }>
  | Readonly<{ state: "known_aborted"; operation: ParticipationOperationIdentity }>;
export class GuestParticipationStoreRejected extends Data.TaggedError(
  "GuestParticipationStoreRejected",
)<{
  readonly reason:
    | "proof-revoked"
    | "owner-mismatch"
    | "lease-expired"
    | "authority-conflict"
    | "credential-cleanup-required"
    | "ceremony-cleanup-required"
    | "issuance-requires-restart"
    | "idempotency-conflict"
    | "target-changed"
    | "intent-expired"
    | "not-found"
    | "resource-policy-unavailable"
    | "deletion-in-progress"
    | "recipient-selection-conflict";
}> {}
export type GuestParticipationStoreFailure = GuestParticipationStoreRejected | ControlPlaneError;
type Result<A> = Effect.Effect<A, GuestParticipationStoreFailure>;

/** Transport-only digests enter the verifier/store boundary, never handler JSON or context. */
export interface GuestCredentialVerifier {
  readonly verify: (
    input: Readonly<{
      origin: string;
      credentialProofs: readonly Readonly<{ credentialId: string; digest: string }>[];
      intentProofs: readonly Readonly<{ intentId: string; digest: string }>[];
      cleanup: boolean;
    }>,
  ) => Result<BrowserProofContext>;
}
export type GuestCookieEffect =
  | Readonly<{ kind: "credential"; action: "issue" | "refresh" | "expire"; credentialId: string }>
  | Readonly<{ kind: "intent"; action: "issue" | "expire"; intentId: string }>;
export type GuestAuthorityTransition = Readonly<{
  authority: GuestAuthorityV1;
  cookieEffects: readonly GuestCookieEffect[];
}>;
type Issuance = Readonly<{
  operation: ParticipationOperationIdentity;
  credentialId: string;
  tokenDigest: string;
  pendingExpiresAt: string;
}>;
export interface GuestAuthorityStore {
  readonly discover: (
    input: Readonly<{
      context: Extract<
        BrowserParticipationContext,
        { authority: "bootstrap"; operation: "discover" }
      >;
      expectedOwnerId: string | null;
      previousCredentialId: string | null;
    }>,
  ) => Result<GuestAuthorityV1>;
  readonly issuePending: (
    input: Readonly<{
      context: Extract<BrowserParticipationContext, { authority: "bootstrap"; operation: "issue" }>;
      issuance: Issuance;
      newOwnerId: string;
    }>,
  ) => Result<DurableParticipationOutcome<GuestAuthorityTransition>>;
  /** Natural-key replay is (origin, credentialId). Preserve transaction-unknown errors;
   * discover/replay reconciles this exact key without extending an already confirmed lease.
   */
  readonly confirm: (
    input: Readonly<{
      context: Extract<
        BrowserParticipationContext,
        { authority: "bootstrap"; operation: "confirm" }
      >;
      expectedOwnerId: string;
      credentialId: string;
    }>,
  ) => Result<GuestAuthorityTransition>;
  /** Renewal uncertainty is read through discover before any new deliberate renewal. */
  readonly renew: (
    input: Readonly<{
      context: Extract<
        BrowserParticipationContext,
        { authority: "recovery"; operation: "renew" | "rotate" | "create_attachment_intent" }
      > & { readonly operation: "renew" };
      expectedOwnerId: string;
    }>,
  ) => Result<GuestAuthorityTransition>;
  readonly issueRotation: (
    input: Readonly<{
      context: Extract<
        BrowserParticipationContext,
        { authority: "recovery"; operation: "renew" | "rotate" | "create_attachment_intent" }
      > & { readonly operation: "rotate" };
      expectedOwnerId: string;
      issuance: Issuance;
    }>,
  ) => Result<DurableParticipationOutcome<GuestAuthorityTransition>>;
  /** Natural key is (origin, predecessorCredentialId, successorCredentialId). Unknown COMMIT
   * reconciles by exact successor proof through discover/replay, without extending its lease.
   */
  readonly acknowledgeRotation: (
    input: Readonly<{
      context: Extract<
        BrowserParticipationContext,
        { authority: "recovery"; operation: "acknowledge" }
      >;
      expectedOwnerId: string;
      predecessorCredentialId: string;
      successorCredentialId: string;
    }>,
  ) => Result<GuestAuthorityTransition>;
  /** Recheck zero sessions/qualifications/participations/liabilities under the same locks. */
  readonly cleanup: (
    input: Readonly<{
      context: CleanupDispositionContext;
      selectedCredentialId: string | null;
      candidateCredentialIds: readonly string[];
      candidateIntentIds: readonly string[];
    }>,
  ) => Result<
    Readonly<{
      authority: GuestCleanupAuthorityV1;
      cookieEffects: readonly (GuestCookieEffect & { readonly action: "expire" })[];
    }>
  >;
}
export type GuestAttachmentConfirmResult =
  | Readonly<{
      state: "bound";
      binding: GuestAttachmentBindingV1;
      cookieEffects: readonly GuestCookieEffect[];
    }>
  | Readonly<{ state: "participation_conflict"; outcomeId: string }>
  | Readonly<{ state: "target_changed" | "expired" }>;
type AttachmentContext = Extract<BrowserParticipationContext, { authority: "attachment" }>;
export interface GuestAttachmentStore {
  readonly createIntent: (
    input: Readonly<{
      context: Extract<
        BrowserParticipationContext,
        { authority: "recovery"; operation: "renew" | "rotate" | "create_attachment_intent" }
      > & { readonly operation: "create_attachment_intent" };
      expectedOwnerId: string;
      operation: ParticipationOperationIdentity;
      intentId: string;
      nonceDigest: string;
      expiresAt: string;
    }>,
  ) => Result<
    DurableParticipationOutcome<
      Readonly<{ intent: GuestAttachmentIntentV1; cookieEffects: readonly GuestCookieEffect[] }>
    >
  >;
  /** Preparation owns its natural-key reconciliation under the intent lock. Same CURRENT
   * canonical account/session returns the existing revision. A changed protected session
   * advances revision, including returning to a previously prepared session. The store
   * derives the durable operation from intent + target revision + account/session and
   * reconciles unresolved preparation before advancing. No browser key supplies authority.
   */
  readonly prepareTarget: (
    input: Readonly<{
      context: AttachmentContext & { readonly operation: "prepare_target" };
      intentId: string;
    }>,
  ) => Result<DurableParticipationOutcome<GuestAttachmentPreparedV1>>;
  /** Owns topology locks, target/session recheck, conflict outcome, binding and revocation COMMIT. */
  readonly confirm: (
    input: Readonly<{
      context: AttachmentContext & { readonly operation: "confirm_target" };
      intentId: string;
      expectedAccountId: string;
      targetRevision: number;
      /** Server derives the stable confirmation key from intent and stored target revision. */
      operation: ParticipationOperationIdentity;
    }>,
  ) => Result<DurableParticipationOutcome<GuestAttachmentConfirmResult>>;
  readonly findBoundAttachment: (
    input: Readonly<{
      account: OrdinaryBrowserAccount | SetupBrowserAccount;
      attachmentId: string;
    }>,
  ) => Result<GuestAttachmentBindingV1 | null>;
}
export interface GuestParticipationReadStore {
  readonly list: (
    input: Readonly<{ access: RecoveryAccess; cursor: string | null; limit: number }>,
  ) => Result<
    Readonly<{ items: readonly GuestParticipationProjectionV1[]; nextCursor: string | null }>
  >;
}
export interface GuestLearningRetentionStore {
  readonly set: (
    input: Readonly<{
      access: RecoveryAccess;
      operation: ParticipationOperationIdentity;
      mode: "private_learning" | "ephemeral";
    }>,
  ) => Result<DurableParticipationOutcome<GuestLearningRetentionV1>>;
}
