import type {
  GuestCredentialVerifier,
  GuestParticipationStoreFailure,
  ProvedGuestCredential,
  ProvedGuestIntent,
} from "@pirate/application/guest-participation-authority";
import type { Effect } from "effect";

export type GuestProofInput = Parameters<GuestCredentialVerifier["verify"]>[0];
export type CredentialProvenance = Readonly<{
  credentialId: string;
  credentialSourceOwnerId: string;
  effectiveOwnerId: string;
  origin: string;
}>;
export type VerifiedGuestCredential = ProvedGuestCredential &
  CredentialProvenance &
  Readonly<{
    /** ownerId is the resolved owner for frozen access/learning projection. */
    ownerId: string;
    pendingActive: boolean;
    learningLeaseActive: boolean;
  }>;
export type VerifiedGuestIntent = ProvedGuestIntent &
  Readonly<{
    credentialSourceOwnerId: string;
    effectiveOwnerId: string;
    active: boolean;
  }>;
export type GuestProofSnapshot = Readonly<{
  origin: string;
  databaseObservedAt: string;
  provedCredentials: readonly VerifiedGuestCredential[];
  provedIntents: readonly VerifiedGuestIntent[];
}>;
export interface GuestProofSnapshotReader {
  readonly read: (
    input: GuestProofInput,
  ) => Effect.Effect<GuestProofSnapshot, GuestParticipationStoreFailure>;
}

/** A present, confirmed source is not enough: active lease comes from PostgreSQL,
 * and this observation is checked again in the owning admission transaction. */
export type GuestLearningLeaseObservation = Readonly<{
  credential: CredentialProvenance;
  state: "confirmed";
  leaseUntil: string;
  databaseObservedAt: string;
  active: boolean;
}>;
