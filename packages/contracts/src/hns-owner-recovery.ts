import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { CommunityCanonicalRouteV1 } from "./community-routes.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  InternalError,
  NotFound,
  OwnerRecoveryInProgress,
  ProviderMisconfigured,
  ProviderUnavailable,
} from "./errors.ts";
import { HnsTxtChallengeV1 } from "./namespace-ownership.ts";

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
const PathSafeCommunityId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._~-]{0,255}$/u),
);
const PositiveSafeInteger = Schema.Int.check(
  Schema.makeFilter((value) =>
    Number.isSafeInteger(value) && value > 0 ? undefined : "Expected a positive safe integer",
  ),
);
const RetryAfterSeconds = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3_600 }));
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

const CommunityPath = Schema.Struct({ communityId: PathSafeCommunityId });

export const HnsOwnerRecoveryStartRequestV1 = Schema.Struct({
  expected_generation: PositiveSafeInteger,
  idempotency_key: OpaqueId,
});
export type HnsOwnerRecoveryStartRequestV1 = Schema.Schema.Type<
  typeof HnsOwnerRecoveryStartRequestV1
>;

export const HnsOwnerRecoveryStartResponseV1 = Schema.Struct({
  route_recovery_id: OpaqueId,
  session_id: OpaqueId,
  generation: PositiveSafeInteger,
  channel: Schema.Literal("poll_result"),
  status: Schema.Literal("pending"),
  expires_at: CanonicalIsoInstant,
  challenge: HnsTxtChallengeV1,
  replayed: Schema.Boolean,
}).check(
  Schema.makeFilter((value) =>
    value.expires_at === value.challenge.expires_at
      ? undefined
      : "Recovery response and challenge expiry must match",
  ),
);
export type HnsOwnerRecoveryStartResponseV1 = Schema.Schema.Type<
  typeof HnsOwnerRecoveryStartResponseV1
>;

export const HnsOwnerRecoveryPollRequestV1 = Schema.Struct({
  route_recovery_id: OpaqueId,
  session_id: OpaqueId,
  expected_generation: PositiveSafeInteger,
  idempotency_key: OpaqueId,
  channel: Schema.Literal("poll_result"),
});
export type HnsOwnerRecoveryPollRequestV1 = Schema.Schema.Type<
  typeof HnsOwnerRecoveryPollRequestV1
>;

const HnsOwnerRecoveryCanonicalRouteV1 = Schema.Struct({
  family: Schema.Literal("hns"),
  root_label: Schema.String,
  root_label_display: Schema.String,
  path_segment: Schema.String,
  href: Schema.String,
  app_host: Schema.Null,
}).check(
  Schema.makeFilter((value) =>
    Schema.is(CommunityCanonicalRouteV1)(value)
      ? undefined
      : "Expected a canonical HNS route without an application host",
  ),
);

const HnsOwnerRecoveryPendingResponseV1 = Schema.Struct({
  route_recovery_id: OpaqueId,
  session_id: OpaqueId,
  generation: PositiveSafeInteger,
  status: Schema.Literals(["pending", "unavailable"]),
  replayed: Schema.Literal(false),
  retry_after_seconds: RetryAfterSeconds,
  result_hash: Schema.Null,
});
const HnsOwnerRecoveryRejectedResponseV1 = Schema.Struct({
  route_recovery_id: OpaqueId,
  session_id: OpaqueId,
  generation: PositiveSafeInteger,
  status: Schema.Literal("rejected"),
  reason_code: Schema.Literals(["root_unavailable", "expiry_insufficient"]),
  replayed: Schema.Boolean,
  retry_after_seconds: Schema.Null,
  result_hash: Sha256Hex,
});
const HnsOwnerRecoveryVerifiedResponseV1 = Schema.Struct({
  route_recovery_id: OpaqueId,
  session_id: OpaqueId,
  generation: PositiveSafeInteger,
  status: Schema.Literal("verified"),
  canonical_route: HnsOwnerRecoveryCanonicalRouteV1,
  replayed: Schema.Boolean,
  retry_after_seconds: Schema.Null,
  result_hash: Sha256Hex,
});
const HnsOwnerRecoveryExpiredResponseV1 = Schema.Struct({
  route_recovery_id: OpaqueId,
  session_id: OpaqueId,
  generation: PositiveSafeInteger,
  status: Schema.Literal("expired"),
  replayed: Schema.Boolean,
  retry_after_seconds: Schema.Null,
  result_hash: Sha256Hex,
});

export const HnsOwnerRecoveryPollResponseV1 = Schema.Union([
  HnsOwnerRecoveryPendingResponseV1,
  HnsOwnerRecoveryRejectedResponseV1,
  HnsOwnerRecoveryVerifiedResponseV1,
  HnsOwnerRecoveryExpiredResponseV1,
]);
export type HnsOwnerRecoveryPollResponseV1 = Schema.Schema.Type<
  typeof HnsOwnerRecoveryPollResponseV1
>;

const hnsOwnerRecoveryErrors = [
  AuthError,
  BadRequest,
  Conflict,
  OwnerRecoveryInProgress,
  NotFound,
  ProviderUnavailable,
  ProviderMisconfigured,
  InternalError,
] as const;

export const StartHnsOwnerRecovery = endpoint({
  method: "POST",
  path: "/communities/:communityId/canonical-route/ownership-recovery/start",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: CommunityPath,
    exactRawPathParameters: ["communityId"],
    body: HnsOwnerRecoveryStartRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 1_024,
  },
  response: HnsOwnerRecoveryStartResponseV1,
  successStatus: [200, 201],
  errors: hnsOwnerRecoveryErrors,
});

export const PollHnsOwnerRecovery = endpoint({
  method: "POST",
  path: "/communities/:communityId/canonical-route/ownership-recovery/poll",
  auth: Auth.user({ browserSessionOnly: true }),
  request: {
    path: CommunityPath,
    exactRawPathParameters: ["communityId"],
    body: HnsOwnerRecoveryPollRequestV1,
    bodyEncoding: "exact-json",
    maxBodyBytes: 2_048,
  },
  response: HnsOwnerRecoveryPollResponseV1,
  successStatus: [200, 202, 422, 503],
  errors: hnsOwnerRecoveryErrors,
});
