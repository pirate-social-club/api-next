import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  HandleRequestRejected,
  InternalError,
  RateLimited,
  RetryableHandleRequestRejected,
} from "./errors.ts";
import {
  BoundedIdentifier,
  CanonicalInstant,
  IdempotencyKey,
  PositiveInteger,
  Sha256Hex,
} from "./handle-sales-scalars.ts";

const Lifetime = Schema.Struct({
  kind: Schema.Literal("max_age_seconds"),
  seconds: PositiveInteger,
});
const Providers = Schema.Tuple([Schema.Literal("self.pass"), Schema.Literal("zkpassport")]);

export const HandleNationalityQualificationPolicyRefV1 = Schema.Struct({
  kind: Schema.Literal("curated_nationality_v1"),
  policy_id: BoundedIdentifier,
  policy_revision: PositiveInteger,
  policy_hash: Sha256Hex,
  requirement_hash: Sha256Hex,
  provider_binding_hashes: Schema.Tuple([Sha256Hex, Sha256Hex]),
  lifetime: Lifetime,
});
export type HandleNationalityQualificationPolicyRefV1 = Schema.Schema.Type<
  typeof HandleNationalityQualificationPolicyRefV1
>;

export const HandleNationalityAuthoringContextV1 = Schema.Struct({
  kind: Schema.Literal("nationality_authoring_context_v1"),
  community_id: BoundedIdentifier,
  authoring_reference: Sha256Hex,
  policy_revision: PositiveInteger,
  lifetime: Lifetime,
  accepted_provider_ids: Providers,
});
export type HandleNationalityAuthoringContextV1 = Schema.Schema.Type<
  typeof HandleNationalityAuthoringContextV1
>;

export const HandleNationalityPolicyAuthoredV1 = Schema.Struct({
  kind: Schema.Literal("nationality_policy_authored_v1"),
  request_hash: Sha256Hex,
  qualification_policy: HandleNationalityQualificationPolicyRefV1,
  created_at: CanonicalInstant,
  replayed: Schema.Boolean,
});
export type HandleNationalityPolicyAuthoredV1 = Schema.Schema.Type<
  typeof HandleNationalityPolicyAuthoredV1
>;

const errors = [
  AuthError,
  BadRequest,
  HandleRequestRejected,
  RetryableHandleRequestRejected,
  RateLimited,
  InternalError,
] as const;
const CommunityPath = Schema.Struct({ communityId: BoundedIdentifier });

export const GetHandleNationalityAuthoring = endpoint({
  method: "GET",
  path: "/communities/:communityId/handle-nationality-authoring",
  auth: Auth.userOrAdmin(),
  request: { path: CommunityPath },
  response: HandleNationalityAuthoringContextV1,
  errors,
});

export const CreateHandleNationalityQualificationPolicy = endpoint({
  method: "POST",
  path: "/communities/:communityId/handle-nationality-qualification-policies",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPath,
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      authoring_reference: Sha256Hex,
      allowed_countries: Schema.NonEmptyArray(Schema.NonEmptyString).check(Schema.isMaxLength(256)),
    }),
  },
  response: HandleNationalityPolicyAuthoredV1,
  successStatus: [200, 201],
  errors,
});
