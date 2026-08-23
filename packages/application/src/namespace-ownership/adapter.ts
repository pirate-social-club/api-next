import { CommunityCanonicalRouteV1, ProviderPresentation } from "@pirate/contracts";
import { ProviderConfigurationRef, Sha256Hex } from "@pirate/domain/verification";
import { Data, type Effect, Schema } from "effect";

const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

const PositiveMilliseconds = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 && value <= 600_000
      ? undefined
      : "Expected a positive millisecond deadline no larger than ten minutes",
  ),
);

const CanonicalNonEmptyString = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value ? undefined : "Expected a non-empty value without edge whitespace",
  ),
);

const CanonicalIsoInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);

function isControlFree(value: string): boolean {
  return [...value].every((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint >= 0x20 && !(codePoint >= 0x7f && codePoint <= 0x9f);
  });
}

const BoundedEvidenceReference = CanonicalNonEmptyString.check(
  Schema.makeFilter((value) =>
    new TextEncoder().encode(value).byteLength <= 512 && isControlFree(value)
      ? undefined
      : "Expected a bounded evidence reference without control characters",
  ),
);

export const NAMESPACE_OWNERSHIP_UPSTREAM_SESSION_REF_MAX_BYTES = 16_384 as const;
export const NamespaceOwnershipUpstreamSessionReference = CanonicalNonEmptyString.check(
  Schema.makeFilter((value) =>
    new TextEncoder().encode(value).length <= NAMESPACE_OWNERSHIP_UPSTREAM_SESSION_REF_MAX_BYTES &&
    isControlFree(value)
      ? undefined
      : "Expected a bounded upstream namespace session reference without control characters",
  ),
);

export const NamespaceOwnershipSubmissionChannel = Schema.Literals([
  "client_result",
  "provider_callback",
  "poll_result",
]);
export type NamespaceOwnershipSubmissionChannel = Schema.Schema.Type<
  typeof NamespaceOwnershipSubmissionChannel
>;

/** `provider_id` is target registration authority, never a legacy observation-source label. */
export const NamespaceOwnershipProviderManifest = Schema.Struct({
  provider_id: CanonicalNonEmptyString,
  manifest_version: CanonicalNonEmptyString,
  supported_families: Schema.NonEmptyArray(Schema.Literals(["hns", "spaces"])),
  protocol_versions: Schema.NonEmptyArray(CanonicalNonEmptyString),
  environments: Schema.NonEmptyArray(CanonicalNonEmptyString),
  submission_channels: Schema.NonEmptyArray(NamespaceOwnershipSubmissionChannel),
  operation_deadlines: Schema.Struct({
    plan_ms: PositiveMilliseconds,
    start_ms: PositiveMilliseconds,
    complete_ms: PositiveMilliseconds,
  }),
}).check(
  Schema.makeFilter((manifest) =>
    new Set(manifest.supported_families).size === manifest.supported_families.length &&
    new Set(manifest.protocol_versions).size === manifest.protocol_versions.length &&
    new Set(manifest.environments).size === manifest.environments.length &&
    new Set(manifest.submission_channels).size === manifest.submission_channels.length
      ? undefined
      : "Namespace provider manifest lists must be unique",
  ),
);
export type NamespaceOwnershipProviderManifest = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderManifest
>;

/** Host-routing health is deliberately outside namespace ownership authority. */
export const NamespaceOwnershipRoute = CommunityCanonicalRouteV1.check(
  Schema.makeFilter((route) =>
    route.app_host === null
      ? undefined
      : "Namespace ownership cannot authorize an HNS application host",
  ),
);
export type NamespaceOwnershipRoute = Schema.Schema.Type<typeof NamespaceOwnershipRoute>;

export const NamespaceOwnershipProviderPlanInput = Schema.Struct({
  route: NamespaceOwnershipRoute,
  environment: CanonicalNonEmptyString,
});
export type NamespaceOwnershipProviderPlanInput = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderPlanInput
>;

export const NamespaceOwnershipProviderPlanResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("supported"),
    provider_configuration: ProviderConfigurationRef,
    protocol_version: CanonicalNonEmptyString,
  }),
  Schema.Struct({ status: Schema.Literal("unsupported") }),
]);
export type NamespaceOwnershipProviderPlanResult = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderPlanResult
>;

export const NamespaceOwnershipSession = Schema.Struct({
  actor_id: CanonicalNonEmptyString,
  creation_intent_id: CanonicalNonEmptyString,
  ceremony_intent_id: CanonicalNonEmptyString,
  requirement_hash: Sha256Hex,
  generation: PositiveInteger,
  request_hash: Sha256Hex,
  provider_id: CanonicalNonEmptyString,
  provider_binding_hash: Sha256Hex,
  provider_configuration: ProviderConfigurationRef,
  protocol_version: CanonicalNonEmptyString,
  environment: CanonicalNonEmptyString,
  route: NamespaceOwnershipRoute,
  upstream_session_ref: NamespaceOwnershipUpstreamSessionReference,
  expires_at: CanonicalIsoInstant,
});
export type NamespaceOwnershipSession = Schema.Schema.Type<typeof NamespaceOwnershipSession>;

export const NamespaceOwnershipProviderStartInput = Schema.Struct({
  actor_id: CanonicalNonEmptyString,
  creation_intent_id: CanonicalNonEmptyString,
  ceremony_intent_id: CanonicalNonEmptyString,
  requirement_hash: Sha256Hex,
  generation: PositiveInteger,
  request_hash: Sha256Hex,
  provider_binding_hash: Sha256Hex,
  provider_configuration: ProviderConfigurationRef,
  protocol_version: CanonicalNonEmptyString,
  environment: CanonicalNonEmptyString,
  route: NamespaceOwnershipRoute,
});
export type NamespaceOwnershipProviderStartInput = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderStartInput
>;

export const NamespaceOwnershipProviderStartContext = Schema.Struct({
  namespace_session_id: CanonicalNonEmptyString.check(
    Schema.makeFilter((value) =>
      new TextEncoder().encode(value).byteLength <= 256 && isControlFree(value)
        ? undefined
        : "Expected a bounded namespace session id without control characters",
    ),
  ),
});
export type NamespaceOwnershipProviderStartContext = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderStartContext
>;

export const NamespaceOwnershipProviderStartResult = Schema.Struct({
  session: NamespaceOwnershipSession,
  presentation: ProviderPresentation,
});
export type NamespaceOwnershipProviderStartResult = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderStartResult
>;

const BoundedSubmissionPayload = Schema.Json.check(
  Schema.makeFilter((value) =>
    new TextEncoder().encode(JSON.stringify(value)).length <= 1_048_576
      ? undefined
      : "Expected a JSON provider submission no larger than 1 MiB",
  ),
);

export const NAMESPACE_OWNERSHIP_RAW_RESPONSE_MAX_BYTES = 1_048_576 as const;
const BoundedRawResponseBytes = Schema.Uint8Array.check(
  Schema.makeFilter((value) =>
    value.byteLength > 0 && value.byteLength <= NAMESPACE_OWNERSHIP_RAW_RESPONSE_MAX_BYTES
      ? undefined
      : "Expected non-empty provider response bytes no larger than 1 MiB",
  ),
);

export const NamespaceOwnershipSubmission = Schema.Struct({
  channel: NamespaceOwnershipSubmissionChannel,
  payload: BoundedSubmissionPayload,
});
export type NamespaceOwnershipSubmission = Schema.Schema.Type<typeof NamespaceOwnershipSubmission>;

export const NamespaceOwnershipProviderCompleteInput = Schema.Struct({
  session: NamespaceOwnershipSession,
  submission: NamespaceOwnershipSubmission,
});
export type NamespaceOwnershipProviderCompleteInput = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderCompleteInput
>;

export const NamespaceOwnershipProviderCompleteContext = Schema.Struct({
  namespace_session_id: NamespaceOwnershipProviderStartContext.fields.namespace_session_id,
  observation_id: CanonicalNonEmptyString.check(
    Schema.makeFilter((value) =>
      new TextEncoder().encode(value).byteLength <= 256 && isControlFree(value)
        ? undefined
        : "Expected a bounded observation id without control characters",
    ),
  ),
});
export type NamespaceOwnershipProviderCompleteContext = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderCompleteContext
>;

export const NamespaceOwnershipProviderCompleteResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  /**
   * Raw provider evidence is intentionally not an ownership envelope.  The
   * completion reservation supplies `evidence_ref`; the application evidence
   * builder computes every authoritative digest later from these exact bytes
   * and provider-specific strict semantic facts.
   */
  Schema.Struct({
    status: Schema.Literal("verified"),
    evidence_kind: Schema.Literal("raw_provider_response_v1"),
    provider_evidence_ref: BoundedEvidenceReference,
    raw_response_bytes: BoundedRawResponseBytes,
    observation: BoundedSubmissionPayload,
    observed_at: CanonicalIsoInstant,
    expires_at: Schema.NullOr(CanonicalIsoInstant),
  }).check(
    Schema.makeFilter((result) =>
      result.expires_at === null || Date.parse(result.expires_at) > Date.parse(result.observed_at)
        ? undefined
        : "Verified namespace evidence must expire after it was observed",
    ),
  ),
]);
export type NamespaceOwnershipProviderCompleteResult = Schema.Schema.Type<
  typeof NamespaceOwnershipProviderCompleteResult
>;

export type NamespaceOwnershipProviderOperation = "plan" | "start" | "complete";

export class NamespaceOwnershipProviderUnavailable extends Data.TaggedError(
  "NamespaceOwnershipProviderUnavailable",
)<{
  readonly provider_id: string;
  readonly operation: NamespaceOwnershipProviderOperation;
}> {}

export class NamespaceOwnershipProviderRejected extends Data.TaggedError(
  "NamespaceOwnershipProviderRejected",
)<{
  readonly provider_id: string;
  readonly operation: NamespaceOwnershipProviderOperation;
}> {}

/** Local input/session authority was not bound to the selected adapter. */
export class NamespaceOwnershipProviderUnboundRejected extends Data.TaggedError(
  "NamespaceOwnershipProviderUnboundRejected",
)<{
  readonly provider_id: string;
  readonly operation: NamespaceOwnershipProviderOperation;
}> {}

/** Strictly decoded, authenticated evidence contradicted the bound ownership claim. */
export class NamespaceOwnershipProviderObservationRejected extends Data.TaggedError(
  "NamespaceOwnershipProviderObservationRejected",
)<{
  readonly provider_id: string;
  readonly operation: "complete";
}> {}

export class NamespaceOwnershipProviderInvalidResponse extends Data.TaggedError(
  "NamespaceOwnershipProviderInvalidResponse",
)<{
  readonly provider_id: string;
  readonly operation: NamespaceOwnershipProviderOperation;
}> {}

export class NamespaceOwnershipProviderMisconfigured extends Data.TaggedError(
  "NamespaceOwnershipProviderMisconfigured",
)<{
  readonly provider_id: string;
  readonly operation: NamespaceOwnershipProviderOperation;
}> {}

export type NamespaceOwnershipProviderFailure =
  | NamespaceOwnershipProviderUnavailable
  | NamespaceOwnershipProviderRejected
  | NamespaceOwnershipProviderUnboundRejected
  | NamespaceOwnershipProviderObservationRejected
  | NamespaceOwnershipProviderInvalidResponse
  | NamespaceOwnershipProviderMisconfigured;

/**
 * Raw target-owned HNS/Spaces adapter. Runtime consumers resolve only the
 * guarded registry projection; implementations never write creation,
 * evidence, or route rows.
 */
export interface NamespaceOwnershipProviderAdapter {
  readonly manifest: NamespaceOwnershipProviderManifest;
  readonly plan: (
    input: NamespaceOwnershipProviderPlanInput,
  ) => Effect.Effect<NamespaceOwnershipProviderPlanResult, NamespaceOwnershipProviderFailure>;
  readonly start: (
    input: NamespaceOwnershipProviderStartInput,
    context: NamespaceOwnershipProviderStartContext,
  ) => Effect.Effect<NamespaceOwnershipProviderStartResult, NamespaceOwnershipProviderFailure>;
  readonly complete: (
    input: NamespaceOwnershipProviderCompleteInput,
    context: NamespaceOwnershipProviderCompleteContext,
  ) => Effect.Effect<NamespaceOwnershipProviderCompleteResult, NamespaceOwnershipProviderFailure>;
}
