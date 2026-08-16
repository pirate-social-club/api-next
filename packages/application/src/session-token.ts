import { Data, type Effect } from "effect";

import type { CanonicalIdentity, IdentityRepositoryError } from "./identity.ts";
import type { ControlPlaneDb, ControlPlaneError } from "./ports.ts";

export type SessionTokenClassification = "user" | "device";

export type SessionTokenScope = {
  readonly value: string;
  readonly tokens: readonly string[];
};

export type SessionPrincipal = {
  readonly userId: string;
  readonly classification: SessionTokenClassification;
  readonly scope: SessionTokenScope;
  readonly canonical: CanonicalIdentity;
};

export type SessionTokenFailureCode =
  | "authentication_failed"
  | "invalid_token"
  | "invalid_claims"
  | "token_expired"
  | "token_not_yet_valid"
  | "insufficient_scope"
  | "classification_mismatch"
  | "control_plane_record_missing"
  | "canonical_alias_invalid";

export class SessionTokenVerificationError extends Data.TaggedError(
  "SessionTokenVerificationError",
)<{
  readonly code: SessionTokenFailureCode;
}> {}

export interface SessionTokenVerifier {
  readonly verify: (input: {
    readonly token: string;
    readonly requiredScope?: string;
    readonly requiredClassification?: SessionTokenClassification;
  }) => Effect.Effect<
    SessionPrincipal,
    SessionTokenVerificationError | ControlPlaneError | IdentityRepositoryError,
    ControlPlaneDb
  >;
}
