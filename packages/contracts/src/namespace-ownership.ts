import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  ProviderMisconfigured,
  ProviderUnavailable,
  RetryableConflict,
} from "./errors.ts";

const utf8Length = (value: string): number => new TextEncoder().encode(value).byteLength;

const isControlFree = (value: string): boolean =>
  [...value].every((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code > 0x1f && !(code >= 0x7f && code <= 0x9f);
  });

const OpaqueId = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value && isControlFree(value) && utf8Length(value) <= 256
      ? undefined
      : "Expected a bounded canonical opaque id",
  ),
);

const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);

const RetryAfterSeconds = PositiveSafeInteger.check(
  Schema.makeFilter((value) =>
    value <= 3_600 ? undefined : "Expected retry_after_seconds no greater than 3600",
  ),
);

const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}$/u.test(value) ? undefined : "Expected lowercase SHA-256 hexadecimal",
  ),
);

const CanonicalIsoInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical UTC ISO instant";
  }),
);

const HnsChallengeName = OpaqueId.check(
  Schema.makeFilter((value) =>
    utf8Length(value) <= 255 ? undefined : "Expected a bounded HNS TXT challenge name",
  ),
);
const HnsChallengeValue = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value && isControlFree(value) && utf8Length(value) <= 16_448
      ? undefined
      : "Expected a bounded HNS TXT challenge value",
  ),
);

export const HnsTxtChallengeV1 = Schema.Union([
  Schema.Struct({
    ownership_source: Schema.Literal("hns_parent_chain_txt"),
    challenge_name: HnsChallengeName,
    challenge_value: HnsChallengeValue,
    expires_at: CanonicalIsoInstant,
  }),
  Schema.Struct({
    ownership_source: Schema.Literal("owner_authoritative_dns_txt"),
    challenge_name: HnsChallengeName,
    challenge_value: HnsChallengeValue,
    expires_at: CanonicalIsoInstant,
  }),
]);
export type HnsTxtChallengeV1 = Schema.Schema.Type<typeof HnsTxtChallengeV1>;

const IntentPath = Schema.Struct({ intentId: OpaqueId });

/** Exact v1 start request; fields are deliberately declared in wire order. */
export const HnsNamespaceStartRequestV1 = Schema.Struct({
  ceremony_intent_id: OpaqueId,
  expected_revision: PositiveSafeInteger,
  idempotency_key: OpaqueId,
});
export type HnsNamespaceStartRequestV1 = Schema.Schema.Type<typeof HnsNamespaceStartRequestV1>;

const HnsNamespaceStartPendingResponseV1 = Schema.Struct({
  creation_intent_id: OpaqueId,
  ceremony_intent_id: OpaqueId,
  generation: PositiveSafeInteger,
  session_id: OpaqueId,
  channel: Schema.Literal("poll_result"),
  status: Schema.Literal("pending"),
  expires_at: CanonicalIsoInstant,
  challenge: HnsTxtChallengeV1,
  replayed: Schema.Boolean,
});

const HnsNamespaceStartVerifiedResponseV1 = Schema.Struct({
  creation_intent_id: OpaqueId,
  ceremony_intent_id: OpaqueId,
  generation: PositiveSafeInteger,
  status: Schema.Literal("verified"),
  result_hash: Sha256Hex,
  replayed: Schema.Literal(true),
});

/** Exact v1 start response union, with no provider presentation fields. */
export const HnsNamespaceStartResponseV1 = Schema.Union([
  HnsNamespaceStartPendingResponseV1,
  HnsNamespaceStartVerifiedResponseV1,
]);
export type HnsNamespaceStartResponseV1 = Schema.Schema.Type<typeof HnsNamespaceStartResponseV1>;

/** Exact v1 poll request; the fixed poll channel is the final wire member. */
export const HnsPollResultCompletionRequestV1 = Schema.Struct({
  ceremony_intent_id: OpaqueId,
  session_id: OpaqueId,
  expected_revision: PositiveSafeInteger,
  idempotency_key: OpaqueId,
  channel: Schema.Literal("poll_result"),
});
export type HnsPollResultCompletionRequestV1 = Schema.Schema.Type<
  typeof HnsPollResultCompletionRequestV1
>;

/** Exact v1 poll outcome response; cross-field checks keep terminal hashes closed. */
export const HnsPollResultCompletionResponseV1 = Schema.Struct({
  ceremony_intent_id: OpaqueId,
  session_id: OpaqueId,
  revision: PositiveSafeInteger,
  status: Schema.Literals(["pending", "unavailable", "rejected", "verified", "expired"]),
  replayed: Schema.Boolean,
  result_hash: Schema.NullOr(Sha256Hex),
  retry_after_seconds: Schema.NullOr(RetryAfterSeconds),
}).check(
  Schema.makeFilter((value) => {
    const terminal =
      value.status === "rejected" || value.status === "verified" || value.status === "expired";
    if (terminal) {
      return value.result_hash !== null && value.retry_after_seconds === null
        ? undefined
        : "Terminal outcomes require result_hash and no retry delay";
    }
    return value.result_hash === null && value.retry_after_seconds !== null
      ? undefined
      : "Non-terminal outcomes require a retry delay and no result hash";
  }),
);
export type HnsPollResultCompletionResponseV1 = Schema.Schema.Type<
  typeof HnsPollResultCompletionResponseV1
>;

const namespaceOwnershipErrors = [
  AuthError,
  BadRequest,
  Conflict,
  RetryableConflict,
  NotFound,
  ProviderUnavailable,
  ProviderMisconfigured,
  InternalError,
] as const;

/** Namespace ownership start; this is not an alias for generic Very start. */
export const StartNamespaceOwnership = endpoint({
  method: "POST",
  path: "/community-creation-intents/:intentId/namespace-ownership/start",
  auth: Auth.userOrAdmin(),
  request: {
    path: IntentPath,
    exactRawPathParameters: ["intentId"],
    body: HnsNamespaceStartRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 2_048,
  },
  response: HnsNamespaceStartResponseV1,
  successStatus: [200, 201],
  errors: namespaceOwnershipErrors,
});

/** Namespace ownership poll; 503 is reserved for the unavailable outcome body. */
export const PollNamespaceOwnership = endpoint({
  method: "POST",
  path: "/community-creation-intents/:intentId/namespace-ownership/poll",
  auth: Auth.userOrAdmin(),
  request: {
    path: IntentPath,
    exactRawPathParameters: ["intentId"],
    body: HnsPollResultCompletionRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 4_096,
  },
  response: HnsPollResultCompletionResponseV1,
  successStatus: [200, 202, 422, 503],
  errors: namespaceOwnershipErrors,
});
