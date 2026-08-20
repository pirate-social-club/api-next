import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import { AuthError, BadRequest, Conflict, InternalError, NotFound } from "./errors.ts";

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
const CommunityRouteSlug = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.length <= 256 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      ? undefined
      : "Expected a lowercase hyphenated route slug of at most 256 characters",
  ),
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

export const CommunityCreationDraft = Schema.Struct({
  name: Schema.NonEmptyString,
  slug: CommunityRouteSlug,
  description: Schema.NullOr(Schema.String),
  policy: CompiledGatePolicy,
});
export type CommunityCreationDraft = Schema.Schema.Type<typeof CommunityCreationDraft>;

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

export const CreationNextAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("start_verification"),
    provider_id: Schema.NonEmptyString,
    intent_id: Schema.NonEmptyString,
  }),
  Schema.Struct({ kind: Schema.Literal("commit") }),
  Schema.Struct({
    kind: Schema.Literal("wait"),
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
export type CreationNextAction = Schema.Schema.Type<typeof CreationNextAction>;

export const CommittedCommunityResource = Schema.Struct({
  community_id: Schema.NonEmptyString,
  href: Schema.NonEmptyString.check(
    Schema.makeFilter((value) =>
      value.startsWith("/") ? undefined : "Expected a same-origin resource path",
    ),
  ),
});
export type CommittedCommunityResource = Schema.Schema.Type<typeof CommittedCommunityResource>;

export const CommunityCreationIntent = Schema.Struct({
  intent_id: Schema.NonEmptyString,
  revision: PositiveInteger,
  status: CommunityCreationStatus,
  draft: CommunityCreationDraft,
  canonical_policy_revision: PositiveInteger,
  canonical_policy_hash: Sha256Hex,
  verification_requirement_hash: Sha256Hex,
  next_action: CreationNextAction,
  expires_at: CanonicalIsoInstant,
  committed_resource: Schema.NullOr(CommittedCommunityResource),
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
      return intent.next_action.kind === "start_verification" &&
        intent.next_action.intent_id === intent.intent_id
        ? undefined
        : "Verification-required intents require their bound start action";
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
    return intent.next_action.kind === "wait"
      ? undefined
      : "Draft intents require an explicit wait action";
  }),
);
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
      draft: CommunityCreationDraft,
    }),
  },
  response: CommunityCreationIntent,
  successStatus: 201,
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
      draft: CommunityCreationDraft,
    }),
  },
  response: CommunityCreationIntent,
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
