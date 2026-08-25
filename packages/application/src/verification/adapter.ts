import { ProviderPresentation as ContractProviderPresentation } from "@pirate/contracts";
import {
  type Assurance,
  CanonicalClaimIdentifier,
  type EvidenceBundle,
  type ProofProviderManifest,
  ProofSession,
  ProviderConfigurationRef,
  Sha256Hex,
  SubjectBindingIntent,
  SubjectScope,
  VerificationRequestMode,
  VerificationRequirements,
} from "@pirate/domain/verification";
import { Data, type Effect, Schema } from "effect";

/** Credentials never cross the public callback boundary. */
export const VERIFICATION_CALLBACK_CREDENTIAL_HEADERS = new Set([
  "authorization",
  "cookie",
  "proxy-authorization",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "cf-access-jwt-assertion",
  "cf-access-client-id",
  "cf-access-client-secret",
]);

/**
 * A presentation is the only provider output exposed to a client. Provider
 * SDK response objects stay inside the adapter and never cross this boundary.
 */
export const ProviderPresentation = ContractProviderPresentation;
export type ProviderPresentation = Schema.Schema.Type<typeof ProviderPresentation>;

export const ProviderSessionStart = Schema.Struct({
  session: ProofSession,
  presentation: ProviderPresentation,
});
export type ProviderSessionStart = Schema.Schema.Type<typeof ProviderSessionStart>;

/**
 * The ceremony transport is explicit while its provider payload stays opaque.
 * Adapters decode and authenticate `payload`; callers cannot smuggle session,
 * actor, provider, or request identity through this envelope.
 */
export const VerificationSubmission = Schema.Struct({
  channel: Schema.Literals(["client_result", "provider_callback", "poll_result"]),
  payload: Schema.Unknown,
});
export type VerificationSubmission = Schema.Schema.Type<typeof VerificationSubmission>;

/**
 * Internal purpose metadata used to scope provider identity proofs. This is
 * resolved server-side from the action intent and is not part of the public
 * verification wire contract.
 */
const VerificationIntentType = Schema.Literals([
  "community_creation",
  "community_join",
  "post_create",
  "comment_create",
  "post_access_18_plus",
  "commerce_pricing",
  "qualifier_disclosure",
  "profile_verification",
]);

const VerificationProviderPurpose = Schema.Struct({
  intent: VerificationIntentType,
  policy_id: Schema.optional(Schema.NonEmptyString),
});

export const VerificationProviderStartInput = Schema.Struct({
  actor_id: Schema.NonEmptyString,
  intent_id: Schema.NonEmptyString,
  request_hash: Sha256Hex,
  method: Schema.NonEmptyString,
  scope: SubjectScope,
  request_mode: VerificationRequestMode,
  provider_configuration: ProviderConfigurationRef,
  requested_requirements: VerificationRequirements,
  requested_claim_ids: Schema.NonEmptyArray(CanonicalClaimIdentifier),
  subject_binding_intent: SubjectBindingIntent,
  protocol_version: Schema.NonEmptyString,
  environment: Schema.NonEmptyString,
  verification_purpose: Schema.optional(VerificationProviderPurpose),
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
  verification_purpose: Schema.optional(VerificationProviderPurpose),
});
export type VerificationProviderPlanInput = Schema.Schema.Type<
  typeof VerificationProviderPlanInput
>;

export const VerificationProviderPlanResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("supported"),
    request_mode: VerificationRequestMode,
    provider_configuration: ProviderConfigurationRef,
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
  submission: VerificationSubmission,
});
export type VerificationProviderCompleteInput = Schema.Schema.Type<
  typeof VerificationProviderCompleteInput
>;

export const VerificationCallbackRawBody = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 && value.length <= 1_048_576
      ? undefined
      : "Expected a non-empty callback body no larger than 1 MiB",
  ),
);

export const VerificationCallbackHeaders = Schema.Record(Schema.String, Schema.String).check(
  Schema.makeFilter((headers) => {
    const entries = Object.entries(headers);
    return entries.length <= 64 &&
      entries.every(
        ([name, value]) =>
          name.length > 0 &&
          name.length <= 128 &&
          /^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) &&
          value.length <= 8_192,
      ) &&
      entries.reduce((length, [name, value]) => length + name.length + value.length, 0) <= 32_768
      ? undefined
      : "Expected a bounded canonical callback header map";
  }),
);

export const VerificationProviderCallbackInput = Schema.Struct({
  raw_body: VerificationCallbackRawBody,
  headers: VerificationCallbackHeaders,
});
export type VerificationProviderCallbackInput = Schema.Schema.Type<
  typeof VerificationProviderCallbackInput
>;

export const VerificationProviderCallbackResolution = Schema.Struct({
  proof_session_id: Schema.NonEmptyString,
  idempotency_key: Schema.NonEmptyString,
  submission: Schema.Struct({
    channel: Schema.Literal("provider_callback"),
    payload: Schema.Unknown,
  }),
});
export type VerificationProviderCallbackResolution = Schema.Schema.Type<
  typeof VerificationProviderCallbackResolution
>;

export const VerificationProviderCallbackResponseInput = Schema.Struct({
  session: ProofSession,
  status: Schema.Literals(["verified", "pending"]),
});
export type VerificationProviderCallbackResponseInput = Schema.Schema.Type<
  typeof VerificationProviderCallbackResponseInput
>;

export type VerificationProviderOperation = "plan" | "start" | "complete" | "callback";

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

/**
 * A submission was rejected before cryptographic proof-to-session binding was
 * established. Completion keeps its short admission lease but must not burn a
 * durable user-attempt slot.
 */
export class VerificationProviderUnboundRejected extends Data.TaggedError(
  "VerificationProviderUnboundRejected",
)<{
  readonly provider_id: string;
  readonly operation: "complete";
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
  | VerificationProviderUnboundRejected
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
  /** Optional signed-callback transport. Client-result providers omit it. */
  readonly verifyCallback?: (
    input: VerificationProviderCallbackInput,
  ) => Effect.Effect<VerificationProviderCallbackResolution, VerificationProviderFailure>;
  /** Session-bound providers structurally extract an opaque proof/session ID. */
  readonly resolveCallback?: (
    input: VerificationProviderCallbackInput,
  ) => Effect.Effect<VerificationProviderCallbackResolution, VerificationProviderFailure>;
  /** Optional provider-owned callback acknowledgment, kept opaque to the application. */
  readonly callbackResponse?: (
    input: VerificationProviderCallbackResponseInput,
  ) => Effect.Effect<Schema.Schema.Type<typeof Schema.Json>, VerificationProviderFailure>;
}

export type VerificationAssurance = Assurance;
