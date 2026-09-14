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

export const HandleNationalityEligibilitySnapshotV1 = Schema.Struct({
  decision: Schema.Literal("passed"),
  policy_revision: PositiveInteger,
  policy_hash: Sha256Hex,
  requirement_hash: Sha256Hex,
  selected_provider_id: Schema.Literals(["self.pass", "zkpassport"]),
  selected_provider_binding_hash: Sha256Hex,
  accepted_provider_ids: Providers,
  lifetime: Lifetime,
  evidence_use_ids: Schema.Array(BoundedIdentifier).check(Schema.isMinLength(1)),
  evaluated_at: CanonicalInstant,
});
export const HandleNationalityQuoteEligibilityV1 = Schema.Struct({
  kind: Schema.Literal("curated_nationality_v1"),
  snapshot: HandleNationalityEligibilitySnapshotV1,
});
export const HandleNationalityQuotePinV1 = Schema.Struct({
  offering_revision: PositiveInteger,
  offering_hash: Sha256Hex,
  qualification: HandleNationalityQualificationPolicyRefV1,
  eligibility: HandleNationalityEligibilitySnapshotV1,
});

export const HandleNationalityRequiredV1 = Schema.Struct({
  kind: Schema.Literal("nationality_required"),
  offering_id: BoundedIdentifier,
  owner_persona_id: BoundedIdentifier,
  qualification_intent_id: BoundedIdentifier,
  reason: Schema.Literal("evidence_required"),
});
const QualificationProgressFields = {
  kind: Schema.Literal("handle_nationality_progress_v1"),
  qualification_intent_id: BoundedIdentifier,
  offering_id: BoundedIdentifier,
  requirement_hash: Sha256Hex,
  accepted_provider_ids: Providers,
};
export const HandleNationalityQualificationProgressV1 = Schema.Union([
  Schema.Struct({
    ...QualificationProgressFields,
    status: Schema.Literal("qualified"),
    next_action: Schema.Struct({ kind: Schema.Literal("request_new_quote") }),
  }),
  Schema.Struct({
    ...QualificationProgressFields,
    status: Schema.Literal("verification_required"),
    next_action: Schema.Struct({
      kind: Schema.Literal("start_verification"),
      provider_id: Schema.Literals(["self.pass", "zkpassport"]),
      intent_id: BoundedIdentifier,
      generation: PositiveInteger,
      requirement: Schema.Literal("nationality"),
    }),
  }),
]);
export type HandleNationalityQualificationProgressV1 = Schema.Schema.Type<
  typeof HandleNationalityQualificationProgressV1
>;
export const GetHandleNationalityQualification = endpoint({
  method: "GET",
  path: "/handle-qualification-intents/:intentId",
  auth: Auth.userOrAdmin(),
  request: { path: Schema.Struct({ intentId: BoundedIdentifier }) },
  response: HandleNationalityQualificationProgressV1,
  errors,
});
