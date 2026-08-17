import {
  type Assurance,
  type CanonicalClaimIdentifier,
  type EvidenceBundle,
  type ProofProviderManifest,
  ProofSession,
  type SubjectScope,
} from "@pirate/domain/verification";
import { Data, type Effect, Schema } from "effect";

/**
 * A presentation is the only provider output exposed to a client. Provider
 * SDK response objects stay inside the adapter and never cross this boundary.
 */
export const ProviderPresentation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("redirect"),
    session_id: Schema.NonEmptyString,
    url: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("deeplink"),
    session_id: Schema.NonEmptyString,
    uri: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("embedded_sdk"),
    session_id: Schema.NonEmptyString,
    protocol: Schema.NonEmptyString,
    version: Schema.NonEmptyString,
    payload: Schema.Json,
  }),
  Schema.Struct({
    kind: Schema.Literal("poll"),
    session_id: Schema.NonEmptyString,
    poll_url: Schema.NonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("none"),
    session_id: Schema.NonEmptyString,
  }),
]);
export type ProviderPresentation = Schema.Schema.Type<typeof ProviderPresentation>;

export const ProviderSessionStart = Schema.Struct({
  session: ProofSession,
  presentation: ProviderPresentation,
});
export type ProviderSessionStart = Schema.Schema.Type<typeof ProviderSessionStart>;

export type VerificationProviderStartInput = Readonly<{
  readonly actor_id: string;
  readonly intent_id: string;
  readonly request_hash: string;
  readonly method: string;
  readonly scope: SubjectScope;
  readonly requested_claim_ids: readonly [CanonicalClaimIdentifier, ...CanonicalClaimIdentifier[]];
  readonly protocol_version: string;
  readonly environment: string;
}>;

export type VerificationProviderVerifyInput = Readonly<{
  readonly session: Schema.Schema.Type<typeof ProofSession>;
  /** Provider-specific callback/token/credential; never the launch presentation. */
  readonly submission: unknown;
}>;

/** Adapter failures are deliberately closed and contain no upstream payload. */
export class VerificationProviderUnavailable extends Data.TaggedError(
  "VerificationProviderUnavailable",
)<{
  readonly provider_id: string;
  readonly operation: "start" | "verify";
}> {}

export class VerificationProviderRejected extends Data.TaggedError("VerificationProviderRejected")<{
  readonly provider_id: string;
  readonly operation: "start" | "verify";
}> {}

export class VerificationProviderInvalidResponse extends Data.TaggedError(
  "VerificationProviderInvalidResponse",
)<{
  readonly provider_id: string;
  readonly operation: "start" | "verify";
}> {}

export class VerificationProviderMisconfigured extends Data.TaggedError(
  "VerificationProviderMisconfigured",
)<{
  readonly provider_id: string;
  readonly operation: "start" | "verify";
}> {}

export type VerificationProviderFailure =
  | VerificationProviderUnavailable
  | VerificationProviderRejected
  | VerificationProviderInvalidResponse
  | VerificationProviderMisconfigured;

/**
 * Provider adapters translate one external protocol into this stable shape.
 * They do not write the evidence ledger and do not import HTTP contracts.
 */
export interface VerificationProviderAdapter {
  readonly manifest: ProofProviderManifest;
  readonly start: (
    input: VerificationProviderStartInput,
  ) => Effect.Effect<ProviderSessionStart, VerificationProviderFailure>;
  readonly verify: (
    input: VerificationProviderVerifyInput,
  ) => Effect.Effect<EvidenceBundle, VerificationProviderFailure>;
}

export type VerificationAssurance = Assurance;
