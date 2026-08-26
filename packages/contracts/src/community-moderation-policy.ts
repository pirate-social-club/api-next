import { Schema } from "effect";

export const MODERATION_POLICY_CATEGORIES_V1 = [
  "harassment",
  "harassment/threatening",
  "hate",
  "hate/threatening",
  "illicit",
  "illicit/violent",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "sexual",
  "sexual/minors",
  "violence",
  "violence/graphic",
] as const;

export const CONTENT_RATINGS_V1 = ["general", "adult_18"] as const;

export const ModerationPolicyCategoryV1 = Schema.Literals(MODERATION_POLICY_CATEGORIES_V1);
export type ModerationPolicyCategoryV1 = Schema.Schema.Type<typeof ModerationPolicyCategoryV1>;

export const ModerationPolicyDecisionV1 = Schema.Literals(["permit", "review", "block"]);
export type ModerationPolicyDecisionV1 = Schema.Schema.Type<typeof ModerationPolicyDecisionV1>;

export const ContentRatingV1 = Schema.Literals(CONTENT_RATINGS_V1);
export type ContentRatingV1 = Schema.Schema.Type<typeof ContentRatingV1>;

/** A revision is complete: every closed category is stored explicitly. */
export const ModerationPolicyTableV1 = Schema.Record(
  ModerationPolicyCategoryV1,
  ModerationPolicyDecisionV1,
);
export type ModerationPolicyTableV1 = Schema.Schema.Type<typeof ModerationPolicyTableV1>;

export const ModerationPolicyFailClosedReasonV1 = Schema.Literals([
  "platform_floor_invalid",
  "community_policy_invalid",
  "matched_categories_invalid",
  "unknown_category",
  "author_rating_invalid",
]);
export type ModerationPolicyFailClosedReasonV1 = Schema.Schema.Type<
  typeof ModerationPolicyFailClosedReasonV1
>;

export const ModerationPolicyResolverInputV1 = Schema.Struct({
  platform_floor: ModerationPolicyTableV1,
  community_policy: ModerationPolicyTableV1,
  matched_categories: Schema.Array(ModerationPolicyCategoryV1),
  author_declared_rating: ContentRatingV1,
});
export type ModerationPolicyResolverInputV1 = Schema.Schema.Type<
  typeof ModerationPolicyResolverInputV1
>;

const MatchedCategoryDecisionsV1 = Schema.Record(
  ModerationPolicyCategoryV1,
  Schema.optional(ModerationPolicyDecisionV1),
);

export const ModerationPolicyResolutionV1 = Schema.Struct({
  matched_categories: Schema.Array(ModerationPolicyCategoryV1),
  category_decisions: MatchedCategoryDecisionsV1,
  effective_policy_decision: ModerationPolicyDecisionV1,
  automated_rating: ContentRatingV1,
  resulting_content_rating: ContentRatingV1,
  fail_closed_reasons: Schema.Array(ModerationPolicyFailClosedReasonV1),
});
export type ModerationPolicyResolutionV1 = Schema.Schema.Type<typeof ModerationPolicyResolutionV1>;
