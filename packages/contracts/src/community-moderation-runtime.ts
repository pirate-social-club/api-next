import { Schema } from "effect";
import { Auth } from "./auth.ts";
import {
  ContentRatingV1,
  ModerationPolicyCategoryV1,
  ModerationPolicyDecisionV1,
  ModerationPolicyTableV1,
} from "./community-moderation-policy.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  CommentsLocked,
  Conflict,
  IdempotencyConflict,
  InternalError,
  MembershipRequired,
  NotFound,
  RateLimited,
  ReplyDepthExceeded,
} from "./errors.ts";

export const CommunityModerationCapabilityV1 = Schema.Literals([
  "moderation.view",
  "moderation.act",
]);

export const CommunityModerationCapabilitiesV1 = Schema.Struct({
  community_id: Schema.String,
  role: Schema.Literal("owner"),
  role_assignment_id: Schema.String,
  capabilities: Schema.Array(CommunityModerationCapabilityV1),
});

export const CommunityModerationPolicyCategoryViewV1 = Schema.Struct({
  category: ModerationPolicyCategoryV1,
  input_types: Schema.Array(Schema.Literals(["text", "image"])),
  platform_floor_decision: ModerationPolicyDecisionV1,
  community_decision: ModerationPolicyDecisionV1,
  effective_decision: ModerationPolicyDecisionV1,
  locked: Schema.Boolean,
  permit_rating: ContentRatingV1,
});

export const CommunityModerationPolicyV1 = Schema.Struct({
  version: Schema.Literal("community-moderation-policy-v1"),
  community_id: Schema.String,
  policy_revision_id: Schema.String,
  policy_hash: Schema.String,
  revision: Schema.Number,
  platform_floor_revision_id: Schema.String,
  platform_floor_hash: Schema.String,
  categories: Schema.Array(CommunityModerationPolicyCategoryViewV1),
  updated_at: Schema.String,
});

export const PutCommunityModerationPolicyV1 = Schema.Struct({
  expected_policy_revision: Schema.String,
  decisions: ModerationPolicyTableV1,
});

export const TextModerationActionV2 = Schema.Literals([
  "approve_as_general",
  "approve_as_adult_18",
  "reject",
  "dismiss_report",
  "hide",
  "raise_rating_to_adult_18",
  "restore",
]);

export const TextModerationTargetStatusV2 = Schema.Literals([
  "held",
  "published",
  "hidden",
  "blocked",
]);

export const ModerateTextCaseV2 = Schema.Struct({
  version: Schema.Literal("moderation-case-action-v2"),
  idempotency_key: Schema.String,
  expected_case_revision: Schema.Number,
  action: TextModerationActionV2,
});

export const ModerateTextCaseResultV2 = Schema.Struct({
  version: Schema.Literal("moderation-case-action-result-v2"),
  action_id: Schema.String,
  case_ref: Schema.String,
  action: TextModerationActionV2,
  target_status: TextModerationTargetStatusV2,
});

export const CommentReportReasonCodeV1 = Schema.Literals([
  "spam",
  "harassment",
  "hate",
  "sexual_content",
  "graphic_content",
  "misleading",
  "other",
]);

export const CommunityContentReportRequestV1 = Schema.Struct({
  idempotency_key: Schema.String,
  reason_code: CommentReportReasonCodeV1,
});

export const CommunityContentReportResponseV1 = Schema.Struct({
  report_id: Schema.String,
  case_ref: Schema.String,
  status: Schema.Literals(["open", "coalesced"]),
});

export const CommunityModerationCaseSourceV1 = Schema.Literals([
  "automatic",
  "member_report",
  "mixed",
]);

export const CommunityModerationCaseSummaryV1 = Schema.Struct({
  case_ref: Schema.String,
  community_id: Schema.String,
  target_type: Schema.Literals(["text_post", "comment", "reply"]),
  target_id: Schema.NullOr(Schema.String),
  author_persona_id: Schema.String,
  source: CommunityModerationCaseSourceV1,
  target_status: TextModerationTargetStatusV2,
  resulting_content_rating: ContentRatingV1,
  case_revision: Schema.Number,
  permitted_actions: Schema.Array(TextModerationActionV2),
  created_at: Schema.String,
  updated_at: Schema.String,
});

export const CommunityModerationCaseListV1 = Schema.Struct({
  object: Schema.Literal("community_moderation_case_list"),
  community_id: Schema.String,
  view: Schema.Literals(["open", "hidden"]),
  items: Schema.Array(CommunityModerationCaseSummaryV1),
});

const ModerationCaseCategoryDecisionsV1 = Schema.Record(
  ModerationPolicyCategoryV1,
  Schema.optional(ModerationPolicyDecisionV1),
);
const ModerationCaseProviderScoresV1 = Schema.Record(
  ModerationPolicyCategoryV1,
  Schema.optional(Schema.Number),
);
const ModerationCaseAppliedTypesV1 = Schema.Record(
  ModerationPolicyCategoryV1,
  Schema.optional(Schema.Array(Schema.Literals(["text", "image"]))),
);

export const ModerationCaseEvidenceV1 = Schema.Struct({
  matched_categories: Schema.Array(ModerationPolicyCategoryV1),
  category_decisions: ModerationCaseCategoryDecisionsV1,
  effective_decision: ModerationPolicyDecisionV1,
  resulting_content_rating: ContentRatingV1,
  author_declared_rating: ContentRatingV1,
  provider_scores: ModerationCaseProviderScoresV1,
  applied_input_types: ModerationCaseAppliedTypesV1,
  policy_revision: Schema.String,
  policy_hash: Schema.String,
  platform_policy_revision: Schema.String,
  platform_policy_hash: Schema.String,
  community_policy_revision: Schema.String,
  community_policy_hash: Schema.String,
});

export const CommunityModerationCasePreviewV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("text"),
    title: Schema.NullOr(Schema.String),
    body: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("locked"),
    reason: Schema.Literal("adult_rating"),
  }),
]);

export const CommunityModerationCaseDetailV1 = Schema.Struct({
  object: Schema.Literal("community_moderation_case"),
  case: CommunityModerationCaseSummaryV1,
  preview: CommunityModerationCasePreviewV1,
  evidence: ModerationCaseEvidenceV1,
});

const PathCommunity = Schema.Struct({ communityId: Schema.String });
const PathCommunityCase = Schema.Struct({
  communityId: Schema.String,
  caseRef: Schema.String,
});
const PathPost = Schema.Struct({ postId: Schema.String });
const PathComment = Schema.Struct({ commentId: Schema.String });
const PathCase = Schema.Struct({ caseRef: Schema.String });

const ownerErrors = [AuthError, BadRequest, NotFound, RateLimited] as const;
const reportErrors = [
  AuthError,
  BadRequest,
  IdempotencyConflict,
  MembershipRequired,
  NotFound,
  RateLimited,
] as const;

export const GetCommunityModerationCapabilities = endpoint({
  method: "GET",
  path: "/communities/:communityId/me/capabilities",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity },
  response: CommunityModerationCapabilitiesV1,
  successStatus: 200,
  errors: ownerErrors,
});

export const ListCommunityModerationCases = endpoint({
  method: "GET",
  path: "/communities/:communityId/moderation/cases",
  auth: Auth.userOrAdmin(),
  request: {
    path: PathCommunity,
    query: Schema.Struct({ view: Schema.Literals(["open", "hidden"]) }),
  },
  response: CommunityModerationCaseListV1,
  successStatus: 200,
  errors: ownerErrors,
});

export const GetCommunityModerationCase = endpoint({
  method: "GET",
  path: "/communities/:communityId/moderation/cases/:caseRef",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunityCase },
  response: CommunityModerationCaseDetailV1,
  successStatus: 200,
  errors: ownerErrors,
});

export const GetCommunityModerationPolicy = endpoint({
  method: "GET",
  path: "/communities/:communityId/moderation/policy",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity },
  response: CommunityModerationPolicyV1,
  successStatus: 200,
  errors: ownerErrors,
});

export const UpdateCommunityModerationPolicy = endpoint({
  method: "PUT",
  path: "/communities/:communityId/moderation/policy",
  auth: Auth.userOrAdmin(),
  request: { path: PathCommunity, body: PutCommunityModerationPolicyV1 },
  response: CommunityModerationPolicyV1,
  successStatus: 200,
  errors: [AuthError, BadRequest, Conflict, NotFound, RateLimited],
});

export const ReportComment = endpoint({
  method: "POST",
  path: "/comments/:commentId/reports",
  auth: Auth.userOrAdmin(),
  request: { path: PathComment, body: CommunityContentReportRequestV1 },
  response: CommunityContentReportResponseV1,
  successStatus: 201,
  errors: reportErrors,
});

export const ReportPost = endpoint({
  method: "POST",
  path: "/posts/:postId/reports",
  auth: Auth.userOrAdmin(),
  request: { path: PathPost, body: CommunityContentReportRequestV1 },
  response: CommunityContentReportResponseV1,
  successStatus: 201,
  errors: reportErrors,
});

export const ModerateCaseAction = endpoint({
  method: "POST",
  path: "/moderation/cases/:caseRef/actions",
  auth: Auth.userOrAdmin(),
  request: { path: PathCase, body: ModerateTextCaseV2 },
  response: ModerateTextCaseResultV2,
  successStatus: 200,
  errors: [
    AuthError,
    BadRequest,
    CommentsLocked,
    Conflict,
    IdempotencyConflict,
    InternalError,
    NotFound,
    RateLimited,
    ReplyDepthExceeded,
  ],
});
