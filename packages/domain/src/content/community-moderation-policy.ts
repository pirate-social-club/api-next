import { Predicate } from "effect";

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

export type ModerationPolicyCategoryV1 = (typeof MODERATION_POLICY_CATEGORIES_V1)[number];
export type ModerationPolicyDecisionV1 = "permit" | "review" | "block";
export type ContentRatingV1 = "general" | "adult_18";
export type ModerationPolicyTableV1 = Readonly<
  Record<ModerationPolicyCategoryV1, ModerationPolicyDecisionV1>
>;

export type ModerationPolicyFailClosedReasonV1 =
  | "platform_floor_invalid"
  | "community_policy_invalid"
  | "matched_categories_invalid"
  | "unknown_category"
  | "author_rating_invalid";

export type ModerationPolicyResolverInputV1 = Readonly<{
  readonly platform_floor: unknown;
  readonly community_policy: unknown;
  readonly matched_categories: unknown;
  readonly author_declared_rating: unknown;
}>;

export type ModerationPolicyResolutionV1 = Readonly<{
  readonly matched_categories: readonly ModerationPolicyCategoryV1[];
  readonly category_decisions: Readonly<
    Partial<Record<ModerationPolicyCategoryV1, ModerationPolicyDecisionV1>>
  >;
  readonly effective_policy_decision: ModerationPolicyDecisionV1;
  readonly automated_rating: ContentRatingV1;
  readonly resulting_content_rating: ContentRatingV1;
  readonly fail_closed_reasons: readonly ModerationPolicyFailClosedReasonV1[];
}>;

export const MODERATION_PLATFORM_FLOOR_V1 = {
  harassment: "permit",
  "harassment/threatening": "review",
  hate: "review",
  "hate/threatening": "review",
  illicit: "permit",
  "illicit/violent": "review",
  "self-harm": "permit",
  "self-harm/intent": "review",
  "self-harm/instructions": "review",
  sexual: "permit",
  "sexual/minors": "block",
  violence: "permit",
  "violence/graphic": "permit",
} as const satisfies ModerationPolicyTableV1;

export const INITIAL_COMMUNITY_MODERATION_POLICY_V1 = {
  harassment: "review",
  "harassment/threatening": "review",
  hate: "review",
  "hate/threatening": "review",
  illicit: "review",
  "illicit/violent": "review",
  "self-harm": "review",
  "self-harm/intent": "review",
  "self-harm/instructions": "review",
  sexual: "review",
  "sexual/minors": "block",
  violence: "review",
  "violence/graphic": "review",
} as const satisfies ModerationPolicyTableV1;

const CATEGORY_SET = new Set<string>(MODERATION_POLICY_CATEGORIES_V1);
const DECISION_SET = new Set<string>(["permit", "review", "block"]);
const DECISION_SEVERITY: Readonly<Record<ModerationPolicyDecisionV1, number>> = {
  permit: 1,
  review: 2,
  block: 3,
};
const ADULT_RATING_CATEGORIES = new Set<ModerationPolicyCategoryV1>(["sexual", "violence/graphic"]);

function isPolicyCategory(value: unknown): value is ModerationPolicyCategoryV1 {
  return Predicate.isString(value) && CATEGORY_SET.has(value);
}

function isPolicyDecision(value: unknown): value is ModerationPolicyDecisionV1 {
  return Predicate.isString(value) && DECISION_SET.has(value);
}

function isPolicyTable(value: unknown): value is ModerationPolicyTableV1 {
  if (!Predicate.isObject(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length !== MODERATION_POLICY_CATEGORIES_V1.length ||
    keys.some((key) => !CATEGORY_SET.has(key))
  ) {
    return false;
  }
  return MODERATION_POLICY_CATEGORIES_V1.every((category) =>
    isPolicyDecision((value as Readonly<Record<string, unknown>>)[category]),
  );
}

function stricterDecision(
  left: ModerationPolicyDecisionV1,
  right: ModerationPolicyDecisionV1,
): ModerationPolicyDecisionV1 {
  return DECISION_SEVERITY[left] >= DECISION_SEVERITY[right] ? left : right;
}

function addFailClosedReason(
  reasons: ModerationPolicyFailClosedReasonV1[],
  reason: ModerationPolicyFailClosedReasonV1,
): void {
  if (!reasons.includes(reason)) reasons.push(reason);
}

/** Pure provider-independent clamp and rating resolver from spec 010 section 4. */
export function resolveCommunityModerationPolicy(
  input: ModerationPolicyResolverInputV1,
): ModerationPolicyResolutionV1 {
  const failClosedReasons: ModerationPolicyFailClosedReasonV1[] = [];
  const platformFloorValid = isPolicyTable(input.platform_floor);
  const communityPolicyValid = isPolicyTable(input.community_policy);
  if (!platformFloorValid) addFailClosedReason(failClosedReasons, "platform_floor_invalid");
  if (!communityPolicyValid) addFailClosedReason(failClosedReasons, "community_policy_invalid");

  const matched = new Set<ModerationPolicyCategoryV1>();
  if (!Array.isArray(input.matched_categories)) {
    addFailClosedReason(failClosedReasons, "matched_categories_invalid");
  } else {
    for (const category of input.matched_categories) {
      if (isPolicyCategory(category)) matched.add(category);
      else addFailClosedReason(failClosedReasons, "unknown_category");
    }
  }
  const matchedCategories = MODERATION_POLICY_CATEGORIES_V1.filter((category) =>
    matched.has(category),
  );

  const authorRatingValid =
    input.author_declared_rating === "general" || input.author_declared_rating === "adult_18";
  if (!authorRatingValid) addFailClosedReason(failClosedReasons, "author_rating_invalid");

  const categoryDecisions: Partial<Record<ModerationPolicyCategoryV1, ModerationPolicyDecisionV1>> =
    {};
  let effectivePolicyDecision: ModerationPolicyDecisionV1 = "permit";
  let automatedRating: ContentRatingV1 = "general";

  for (const category of matchedCategories) {
    const decision =
      platformFloorValid && communityPolicyValid
        ? stricterDecision(input.platform_floor[category], input.community_policy[category])
        : "review";
    categoryDecisions[category] = decision;
    effectivePolicyDecision = stricterDecision(effectivePolicyDecision, decision);
    if (decision === "permit" && ADULT_RATING_CATEGORIES.has(category)) {
      automatedRating = "adult_18";
    }
  }

  if (failClosedReasons.length > 0) {
    effectivePolicyDecision = stricterDecision(effectivePolicyDecision, "review");
  }

  const authorRating: ContentRatingV1 = authorRatingValid
    ? input.author_declared_rating
    : "adult_18";
  const resultingContentRating: ContentRatingV1 =
    authorRating === "adult_18" || automatedRating === "adult_18" ? "adult_18" : "general";

  return {
    matched_categories: matchedCategories,
    category_decisions: categoryDecisions,
    effective_policy_decision: effectivePolicyDecision,
    automated_rating: automatedRating,
    resulting_content_rating: resultingContentRating,
    fail_closed_reasons: failClosedReasons,
  };
}
