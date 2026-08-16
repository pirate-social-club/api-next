import type { ControlPlaneDb } from "@pirate/application";
import type { SessionTokenMinter } from "@pirate/application/use-cases/session-exchange";
import { Data, Effect } from "effect";

import type { CanonicalIdentity, IdentityRepository } from "./identity-repository";
import { type SessionBridge, SessionBridgeError } from "./session-bridge";

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
  }) => Effect.Effect<SessionPrincipal, SessionTokenVerificationError, ControlPlaneDb>;
}

function bridgeFailureCode(error: SessionBridgeError): SessionTokenFailureCode {
  switch (error.code) {
    case "token_expired":
      return "token_expired";
    case "token_not_yet_valid":
      return "token_not_yet_valid";
    case "claims_invalid":
      return "invalid_claims";
    case "subject_invalid":
      return "authentication_failed";
    case "token_malformed":
    case "token_header_invalid":
    case "token_signature_invalid":
    case "configuration_invalid":
    case "key_import_failed":
    case "key_pair_mismatch":
      return "invalid_token";
  }
}

function identityFailureCode(error: unknown): SessionTokenFailureCode {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "IdentityRepositoryError" &&
    "reason" in error
  ) {
    return error.reason === "missing" || error.reason === "deleted"
      ? "control_plane_record_missing"
      : "canonical_alias_invalid";
  }
  return "control_plane_record_missing";
}

export function makeRs256SessionTokenMinter(bridge: SessionBridge): SessionTokenMinter {
  return {
    mint: ({ subject, scope }) =>
      Effect.tryPromise({
        try: () => bridge.sign({ sub: subject, scope }),
        catch: () => new SessionTokenVerificationError({ code: "invalid_claims" }),
      }),
  };
}

/**
 * Application bearer policy over the wave-1 RS256 primitive. Identity lookup
 * remains a repository dependency, keeping SQL and token policy separate.
 */
export function makeRs256SessionTokenVerifier(
  bridge: SessionBridge,
  identityRepository: Pick<IdentityRepository, "resolveCanonical">,
): SessionTokenVerifier {
  return {
    verify: ({ token, requiredScope, requiredClassification }) =>
      Effect.tryPromise({
        try: () => bridge.verify(token),
        catch: (error) =>
          new SessionTokenVerificationError({
            code: error instanceof SessionBridgeError ? bridgeFailureCode(error) : "invalid_token",
          }),
      }).pipe(
        Effect.flatMap((claims) => {
          const scopeValue = claims.scope;
          const scopeTokens = scopeValue.split(/\s+/u).filter(Boolean);
          const classification = scopeValue === bridge.defaultScope ? "user" : ("device" as const);
          if (
            classification === "device" &&
            requiredScope !== undefined &&
            !scopeTokens.includes(requiredScope)
          ) {
            return Effect.fail(new SessionTokenVerificationError({ code: "insufficient_scope" }));
          }
          if (requiredClassification !== undefined && requiredClassification !== classification) {
            return Effect.fail(
              new SessionTokenVerificationError({ code: "classification_mismatch" }),
            );
          }
          return identityRepository.resolveCanonical({ sourceUserId: claims.sub }).pipe(
            Effect.mapError(
              (error) => new SessionTokenVerificationError({ code: identityFailureCode(error) }),
            ),
            Effect.map((canonical) => ({
              userId: canonical.canonicalUserId,
              classification,
              scope: { value: scopeValue, tokens: scopeTokens },
              canonical,
            })),
          );
        }),
      ),
  };
}
