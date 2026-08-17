import {
  type Assurance,
  CanonicalClaimIdentifier,
  type EvidenceBundle,
  type ProofProviderManifest,
  ProofSession,
  Sha256Hex,
  SubjectBindingIntent,
  SubjectScope,
  VerificationRequestMode,
  VerificationRequirements,
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

export const VerificationProviderStartInput = Schema.Struct({
  actor_id: Schema.NonEmptyString,
  intent_id: Schema.NonEmptyString,
  request_hash: Sha256Hex,
  method: Schema.NonEmptyString,
  scope: SubjectScope,
  request_mode: VerificationRequestMode,
  requested_requirements: VerificationRequirements,
  requested_claim_ids: Schema.NonEmptyArray(CanonicalClaimIdentifier),
  subject_binding_intent: SubjectBindingIntent,
  protocol_version: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
});
export type VerificationProviderStartInput = Schema.Schema.Type<
  typeof VerificationProviderStartInput
>;

export const VerificationProviderPlanInput = Schema.Struct({
  method: Schema.NonEmptyString,
  scope: SubjectScope,
  requested_requirements: VerificationRequirements,
  requested_claim_ids: Schema.NonEmptyArray(CanonicalClaimIdentifier),
  subject_binding_intent: SubjectBindingIntent,
  protocol_version: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
});
export type VerificationProviderPlanInput = Schema.Schema.Type<
  typeof VerificationProviderPlanInput
>;

export const VerificationProviderPlanResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("supported"),
    request_mode: VerificationRequestMode,
  }),
  Schema.Struct({ status: Schema.Literal("unsupported") }),
  Schema.Struct({ status: Schema.Literal("unknown") }),
]);
export type VerificationProviderPlanResult = Schema.Schema.Type<
  typeof VerificationProviderPlanResult
>;

export const VerificationProviderCompleteInput = Schema.Struct({
  session: ProofSession,
  /** Provider-specific callback/token/credential; never the launch presentation. */
  submission: Schema.Unknown,
});
export type VerificationProviderCompleteInput = Schema.Schema.Type<
  typeof VerificationProviderCompleteInput
>;

export type VerificationProviderOperation = "plan" | "start" | "complete";

/** Adapter failures are deliberately closed and contain no upstream payload. */
export class VerificationProviderUnavailable extends Data.TaggedError(
  "VerificationProviderUnavailable",
)<{
  readonly provider_id: string;
  readonly operation: VerificationProviderOperation;
}> {}

export class VerificationProviderRejected extends Data.TaggedError("VerificationProviderRejected")<{
  readonly provider_id: string;
  readonly operation: VerificationProviderOperation;
}> {}

export class VerificationProviderInvalidResponse extends Data.TaggedError(
  "VerificationProviderInvalidResponse",
)<{
  readonly provider_id: string;
  readonly operation: VerificationProviderOperation;
}> {}

export class VerificationProviderMisconfigured extends Data.TaggedError(
  "VerificationProviderMisconfigured",
)<{
  readonly provider_id: string;
  readonly operation: VerificationProviderOperation;
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
  /** Request support is configuration support, not a promise about the user's document. */
  readonly plan: (
    input: VerificationProviderPlanInput,
  ) => Effect.Effect<VerificationProviderPlanResult, VerificationProviderFailure>;
  readonly start: (
    input: VerificationProviderStartInput,
  ) => Effect.Effect<ProviderSessionStart, VerificationProviderFailure>;
  readonly complete: (
    input: VerificationProviderCompleteInput,
  ) => Effect.Effect<EvidenceBundle, VerificationProviderFailure>;
}

export type VerificationAssurance = Assurance;
