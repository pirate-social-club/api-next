import { Schema } from "effect";
import { Auth } from "./auth.ts";
import {
  CommunityCreationRequirementsV1,
  CommunityCreationRequirementsV2,
  CreationVerificationRequirementV1,
} from "./community-creation-requirements.ts";
import { CommunityCanonicalRouteV1, CommunityRouteRequestV1 } from "./community-routes.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound } from "./errors.ts";
import { PersonaIdV1, PublicPersonaV1 } from "./personas.ts";

const PositiveInteger = Schema.Int.check(
  Schema.makeFilter((value) => (value > 0 ? undefined : "Expected a positive integer")),
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
      : "Expected a canonical ISO instant";
  }),
);
const CompiledGateRequirement = Schema.Union([
  Schema.Struct({ requirement: Schema.Literal("human-verification") }),
  Schema.Struct({ requirement: Schema.Literal("age-minimum"), minimumAge: Schema.Literal(18) }),
  Schema.Struct({
    requirement: Schema.Literal("nationality-allowed"),
    allowedCountries: Schema.NonEmptyArray(Schema.NonEmptyString),
  }),
  Schema.Struct({
    requirement: Schema.Literal("gender-marker"),
    allowedMarkers: Schema.NonEmptyArray(Schema.Literals(["M", "F"])),
  }),
  Schema.Struct({
    requirement: Schema.Literal("erc721-collection"),
    contractAddress: Schema.NonEmptyString,
    minCount: PositiveInteger,
  }),
  Schema.Struct({
    requirement: Schema.Literal("inventory-match"),
    category: Schema.NonEmptyString,
    subject: Schema.NonEmptyString,
    minQuantity: PositiveInteger,
  }),
  Schema.Struct({
    requirement: Schema.Literal("asset-ownership"),
    assetId: Schema.NonEmptyString,
    minAmount: Schema.NonEmptyString,
  }),
  Schema.Struct({
    requirement: Schema.Literal("reputation-score"),
    provider: Schema.Literal("passport"),
    minimumScore: Schema.Int,
  }),
]);

export const CompiledGatePolicy = Schema.Struct({
  version: Schema.Literal(1),
  accessPaths: Schema.Tuple([
    Schema.Struct({
      id: Schema.NonEmptyString,
      operator: Schema.Literal("and"),
      requirements: Schema.Array(CompiledGateRequirement),
    }),
  ]),
});
export type CompiledGatePolicy = Schema.Schema.Type<typeof CompiledGatePolicy>;

export const CommunityCreationDraftV1 = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NullOr(Schema.String),
  route_request: CommunityRouteRequestV1,
  policy: CompiledGatePolicy,
});
export type CommunityCreationDraftV1 = Schema.Schema.Type<typeof CommunityCreationDraftV1>;

export const CommunityCreationDraftV2 = Schema.Struct({
  persona_id: PersonaIdV1,
  name: Schema.NonEmptyString,
  description: Schema.NullOr(Schema.String),
  policy: CompiledGatePolicy,
});
export type CommunityCreationDraftV2 = Schema.Schema.Type<typeof CommunityCreationDraftV2>;

export const CommunityCreationStatus = Schema.Literals([
  "draft",
  "verification_required",
  "commit_ready",
  "committed",
  "quota_exceeded",
  "gate_unsupported",
  "expired",
  "cancelled",
]);
export type CommunityCreationStatus = Schema.Schema.Type<typeof CommunityCreationStatus>;

export const NextActionWaitReasonCode = Schema.Literals([
  "verification_pending",
  "membership_pending",
  "operation_pending",
  "reconciliation_pending",
]);
export type NextActionWaitReasonCode = Schema.Schema.Type<typeof NextActionWaitReasonCode>;

export const CreationNextActionV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start_verification"),
    requirement: CreationVerificationRequirementV1,
    provider_id: Schema.NonEmptyString,
    creation_intent_id: Schema.NonEmptyString,
    ceremony_intent_id: Schema.NonEmptyString,
    generation: PositiveInteger,
  }),
  Schema.Struct({ kind: Schema.Literal("commit") }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
    requirement: Schema.NullOr(CreationVerificationRequirementV1),
    reason_code: NextActionWaitReasonCode,
    retry_after_seconds: Schema.optional(PositiveInteger),
  }),
  Schema.Struct({
    kind: Schema.Literal("blocked"),
    reason: Schema.Literals(["quota_exceeded", "gate_unsupported"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("none"),
    reason: Schema.Literals(["committed", "expired", "cancelled"]),
  }),
]);
export type CreationNextActionV1 = Schema.Schema.Type<typeof CreationNextActionV1>;

export const CommunityCreationNextActionV2 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start_verification"),
    requirement: Schema.Literal("human_identity"),
    provider_id: Schema.NonEmptyString,
    creation_intent_id: Schema.NonEmptyString,
    ceremony_intent_id: Schema.NonEmptyString,
    generation: PositiveInteger,
  }),
  Schema.Struct({ kind: Schema.Literal("commit") }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
    requirement: Schema.NullOr(Schema.Literal("human_identity")),
    reason_code: NextActionWaitReasonCode,
    retry_after_seconds: Schema.optional(PositiveInteger),
  }),
  Schema.Struct({
    kind: Schema.Literal("blocked"),
    reason: Schema.Literals(["quota_exceeded", "gate_unsupported"]),
  }),
  Schema.Struct({
    kind: Schema.Literal("none"),
    reason: Schema.Literals(["committed", "expired", "cancelled"]),
  }),
]);
export type CommunityCreationNextActionV2 = Schema.Schema.Type<
  typeof CommunityCreationNextActionV2
>;

export const CreationNextAction = Schema.Union([
  CommunityCreationNextActionV2,
  CreationNextActionV1,
]);
export type CreationNextAction = Schema.Schema.Type<typeof CreationNextAction>;

export const CommittedCommunityResourceV1 = Schema.Struct({
  community_id: Schema.NonEmptyString,
  href: Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.startsWith("/c/") ? undefined : "Expected a canonical public community path",
    ),
  ),
  canonical_route: CommunityCanonicalRouteV1,
}).check(
  Schema.makeFilter((resource) =>
    resource.href === resource.canonical_route.href
      ? undefined
      : "Committed resource href must equal its canonical route href",
  ),
);
export type CommittedCommunityResourceV1 = Schema.Schema.Type<typeof CommittedCommunityResourceV1>;

export const OptionalRouteCommunityIdV2 = Schema.String.check(
  Schema.makeFilter((value) =>
    /^community_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
      ? undefined
      : "Expected a generated optional-route community id",
  ),
);
export type OptionalRouteCommunityIdV2 = Schema.Schema.Type<typeof OptionalRouteCommunityIdV2>;

export const CommunityPersonaRolePresentationV1 = Schema.Struct({
  role: Schema.Literal("owner"),
  persona: PublicPersonaV1,
});
export type CommunityPersonaRolePresentationV1 = Schema.Schema.Type<
  typeof CommunityPersonaRolePresentationV1
>;

export const CommittedCommunityResourceV2 = Schema.Struct({
  authority_version: Schema.Literal("optional_route_v2"),
  community_id: OptionalRouteCommunityIdV2,
  href: Schema.NonEmptyString,
  canonical_route: Schema.Null,
  persona_role_presentation: CommunityPersonaRolePresentationV1,
}).check(
  Schema.makeFilter((resource) =>
    resource.href === `/c/${resource.community_id}`
      ? undefined
      : "Committed optional-route href must use its permanent community id",
  ),
);
export type CommittedCommunityResourceV2 = Schema.Schema.Type<typeof CommittedCommunityResourceV2>;

export const CurrentCommunityResourceV2 = Schema.Struct({
  authority_version: Schema.Literal("optional_route_v2"),
  community_id: OptionalRouteCommunityIdV2,
  href: Schema.NonEmptyString,
  canonical_route: Schema.NullOr(CommunityCanonicalRouteV1),
  persona_role_presentation: CommunityPersonaRolePresentationV1,
}).check(
  Schema.makeFilter((resource) =>
    resource.href === `/c/${resource.community_id}`
      ? undefined
      : "Current optional-route href must use its permanent community id",
  ),
);
export type CurrentCommunityResourceV2 = Schema.Schema.Type<typeof CurrentCommunityResourceV2>;

export const CommittedCommunityResource = Schema.Union([
  CommittedCommunityResourceV2,
  CommittedCommunityResourceV1,
]);
export type CommittedCommunityResource = Schema.Schema.Type<typeof CommittedCommunityResource>;

export const CommunityCreationIntentV1 = Schema.Struct({
  intent_id: Schema.NonEmptyString,
  revision: PositiveInteger,
  status: CommunityCreationStatus,
  draft: CommunityCreationDraftV1,
  canonical_policy_revision: PositiveInteger,
  canonical_policy_hash: Sha256Hex,
  requirements: CommunityCreationRequirementsV1,
  next_action: CreationNextActionV1,
  expires_at: CanonicalIsoInstant,
  committed_resource: Schema.NullOr(CommittedCommunityResourceV1),
}).check(
  Schema.makeFilter((intent) => {
    if (intent.status === "committed") {
      return intent.committed_resource !== null &&
        intent.next_action.kind === "none" &&
        intent.next_action.reason === "committed"
        ? undefined
        : "Committed intents require their committed resource and terminal next action";
    }
    if (intent.committed_resource !== null) {
      return "Non-committed intents cannot expose a committed resource";
    }
    if (intent.status === "verification_required") {
      if (intent.next_action.kind === "start_verification") {
        const progress = intent.requirements[intent.next_action.requirement];
        return intent.next_action.creation_intent_id === intent.intent_id &&
          progress.requirement === intent.next_action.requirement &&
          progress.status === "pending" &&
          progress.provider_id === intent.next_action.provider_id &&
          progress.ceremony_intent_id === intent.next_action.ceremony_intent_id &&
          progress.generation === intent.next_action.generation
          ? undefined
          : "Verification start action must match its reserved requirement";
      }
      if (intent.next_action.kind === "wait") {
        return intent.next_action.requirement === null ||
          intent.requirements[intent.next_action.requirement].status === "pending"
          ? undefined
          : "Verification wait action must name a pending requirement";
      }
      return "Verification-required intents require a typed verification action";
    }
    if (intent.status === "commit_ready") {
      return intent.next_action.kind === "commit"
        ? undefined
        : "Commit-ready intents require a commit action";
    }
    if (intent.status === "quota_exceeded" || intent.status === "gate_unsupported") {
      return intent.next_action.kind === "blocked" && intent.next_action.reason === intent.status
        ? undefined
        : "Blocked intents require their matching blocked action";
    }
    if (intent.status === "expired" || intent.status === "cancelled") {
      return intent.next_action.kind === "none" && intent.next_action.reason === intent.status
        ? undefined
        : "Terminal intents require their matching terminal action";
    }
    return intent.next_action.kind === "wait" && intent.next_action.requirement === null
      ? undefined
      : "Draft intents require an explicit wait action";
  }),
);
export type CommunityCreationIntentV1 = Schema.Schema.Type<typeof CommunityCreationIntentV1>;

export const CommunityCreationIntentV2 = Schema.Struct({
  creation_contract_version: Schema.Literal("optional_route_v2"),
  intent_id: Schema.NonEmptyString,
  revision: PositiveInteger,
  status: CommunityCreationStatus,
  draft: CommunityCreationDraftV2,
  canonical_policy_revision: PositiveInteger,
  canonical_policy_hash: Sha256Hex,
  requirements: CommunityCreationRequirementsV2,
  next_action: CommunityCreationNextActionV2,
  expires_at: CanonicalIsoInstant,
  persona_role_presentation: CommunityPersonaRolePresentationV1,
  committed_resource: Schema.NullOr(CommittedCommunityResourceV2),
}).check(
  Schema.makeFilter((intent) => {
    if (intent.persona_role_presentation.persona.persona_id !== intent.draft.persona_id) {
      return "Persona role presentation must match the selected draft persona";
    }
    if (intent.status === "committed") {
      return intent.committed_resource !== null &&
        intent.committed_resource.persona_role_presentation.persona.persona_id ===
          intent.draft.persona_id &&
        intent.next_action.kind === "none" &&
        intent.next_action.reason === "committed"
        ? undefined
        : "Committed intents require their committed resource and terminal next action";
    }
    if (intent.committed_resource !== null) {
      return "Non-committed intents cannot expose a committed resource";
    }
    if (intent.status === "verification_required") {
      if (intent.next_action.kind === "start_verification") {
        const progress = intent.requirements.human_identity;
        return intent.next_action.creation_intent_id === intent.intent_id &&
          progress.requirement === "human_identity" &&
          progress.status === "pending" &&
          progress.provider_id === intent.next_action.provider_id &&
          progress.ceremony_intent_id === intent.next_action.ceremony_intent_id &&
          progress.generation === intent.next_action.generation
          ? undefined
          : "Verification start action must match its reserved human requirement";
      }
      if (intent.next_action.kind === "wait") {
        return intent.next_action.requirement === null ||
          intent.requirements.human_identity.status === "pending"
          ? undefined
          : "Verification wait action must name the pending human requirement";
      }
      return "Verification-required intents require a typed human verification action";
    }
    if (intent.status === "commit_ready") {
      return intent.next_action.kind === "commit"
        ? undefined
        : "Commit-ready intents require a commit action";
    }
    if (intent.status === "quota_exceeded" || intent.status === "gate_unsupported") {
      return intent.next_action.kind === "blocked" && intent.next_action.reason === intent.status
        ? undefined
        : "Blocked intents require their matching blocked action";
    }
    if (intent.status === "expired" || intent.status === "cancelled") {
      return intent.next_action.kind === "none" && intent.next_action.reason === intent.status
        ? undefined
        : "Terminal intents require their matching terminal action";
    }
    return intent.next_action.kind === "wait" && intent.next_action.requirement === null
      ? undefined
      : "Draft intents require an explicit wait action";
  }),
);
export type CommunityCreationIntentV2 = Schema.Schema.Type<typeof CommunityCreationIntentV2>;

export const CommunityCreationIntent = Schema.Union([
  CommunityCreationIntentV2,
  CommunityCreationIntentV1,
]);
export type CommunityCreationIntent = Schema.Schema.Type<typeof CommunityCreationIntent>;

const IntentPath = Schema.Struct({ intentId: Schema.NonEmptyString });
const IdempotencyKey = Schema.Struct({ idempotency_key: Schema.NonEmptyString });

export const CreateCommunityCreationIntent = endpoint({
  method: "POST",
  path: "/community-creation-intents",
  auth: Auth.userOrAdmin(),
  request: {
    body: Schema.Struct({
      idempotency_key: Schema.NonEmptyString,
      draft: CommunityCreationDraftV2,
    }),
  },
  response: CommunityCreationIntentV2,
  successStatus: [200, 201],
  errors: [AuthError, BadRequest, Conflict, InternalError],
});

export const GetCommunityCreationIntent = endpoint({
  method: "GET",
  path: "/community-creation-intents/:intentId",
  auth: Auth.userOrAdmin(),
  request: { path: IntentPath },
  response: CommunityCreationIntent,
  successStatus: 200,
  errors: [AuthError, NotFound, InternalError],
});

export const UpdateCommunityCreationIntent = endpoint({
  method: "PATCH",
  path: "/community-creation-intents/:intentId",
  auth: Auth.userOrAdmin(),
  request: {
    path: IntentPath,
    body: Schema.Struct({
      idempotency_key: Schema.NonEmptyString,
      expected_revision: PositiveInteger,
      draft: CommunityCreationDraftV2,
    }),
  },
  response: CommunityCreationIntentV2,
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, NotFound, InternalError],
});

export const CommitCommunityCreationIntent = endpoint({
  method: "POST",
  path: "/community-creation-intents/:intentId/commit",
  auth: Auth.userOrAdmin(),
  request: {
    path: IntentPath,
    body: Schema.Struct({
      ...IdempotencyKey.fields,
      expected_revision: PositiveInteger,
    }),
  },
  response: CommunityCreationIntent,
  successStatus: [200, 201],
  errors: [AuthError, BadRequest, Conflict, NotFound, InternalError],
});
