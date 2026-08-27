import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, InternalError, RateLimited } from "./errors.ts";

export const MinimumAgeAttestationV1 = Schema.Struct({
  version: Schema.Literal("minimum-age-attestation-v1"),
  minimum_age: Schema.Literal(16),
  affirmed: Schema.Literal(true),
});

export const AgeAttestationProjectionV1 = Schema.Struct({
  age_attestation_required: Schema.Boolean,
  accepted_version: Schema.NullOr(Schema.Literal("minimum-age-attestation-v1")),
  attested_at: Schema.NullOr(Schema.String),
});

export const AccountAgeCapabilityV1 = Schema.Struct({
  content_rating: Schema.Literals(["general", "adult_18"]),
  policy_reference: Schema.NullOr(Schema.String),
  provider_id: Schema.NullOr(Schema.Literals(["self.pass", "self.enterprise", "zkpassport"])),
  evidence_expires_at: Schema.NullOr(Schema.String),
  next_action: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("none") }),
    Schema.Struct({
      kind: Schema.Literal("verify_minimum_age"),
      href: Schema.Literal("/verification/sessions"),
      minimum_age: Schema.Literal(18),
    }),
  ]),
});

export const AgeLockedResourceV1 = Schema.Struct({
  kind: Schema.Literal("age_locked"),
  content_rating: Schema.Literal("adult_18"),
  next_action: Schema.Struct({
    kind: Schema.Literal("verify_minimum_age"),
    minimum_age: Schema.Literal(18),
  }),
});

export const GetMyAgeCapability = endpoint({
  method: "GET",
  path: "/me/age-capability",
  auth: Auth.userOrAdmin(),
  response: AccountAgeCapabilityV1,
  successStatus: 200,
  errors: [AuthError, InternalError, RateLimited],
});

export const PutMyMinimumAgeAttestation = endpoint({
  method: "POST",
  path: "/me/minimum-age-attestation",
  auth: Auth.userOrAdmin(),
  request: { body: MinimumAgeAttestationV1 },
  response: AgeAttestationProjectionV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, InternalError, RateLimited],
});
