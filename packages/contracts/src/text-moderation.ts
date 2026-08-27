import { Schema } from "effect";
import {
  ContentRatingV1,
  ModerationPolicyCategoryV1,
  ModerationPolicyDecisionV1,
} from "./community-moderation-policy.ts";

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
const CanonicalIdentifier = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value ? undefined : "Expected a canonical non-whitespace identifier",
  ),
);
const SameOriginHref = CanonicalIdentifier.check(
  Schema.makeFilter((value) =>
    value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
      ? undefined
      : "Expected a same-origin resource path",
  ),
);

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const CanonicalTextField = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.trim() === value &&
    !value.includes("\r") &&
    value.normalize("NFC") === value &&
    !hasLoneSurrogate(value)
      ? undefined
      : "Expected canonical non-empty NFC text with LF line endings",
  ),
);

export const TextPublicationDecision = Schema.Literals(["allow", "manual_review", "blocked"]);
export type TextPublicationDecision = Schema.Schema.Type<typeof TextPublicationDecision>;

export const TextModerationSurface = Schema.Literals(["text_post", "comment", "reply"]);
export type TextModerationSurface = Schema.Schema.Type<typeof TextModerationSurface>;

export const TextModerationInputV1 = Schema.Struct({
  version: Schema.Literal("text-moderation-input-v1"),
  surface: TextModerationSurface,
  title: Schema.NullOr(CanonicalTextField),
  body: Schema.NullOr(CanonicalTextField),
}).check(
  Schema.makeFilter((input) =>
    input.title !== null || input.body !== null
      ? undefined
      : "Expected at least one canonical text field",
  ),
);
export type TextModerationInputV1 = Schema.Schema.Type<typeof TextModerationInputV1>;

export const TextModerationReasonCode = Schema.Literals([
  "sexual_minors",
  "adult_sexual",
  "graphic_violence",
  "harassment",
  "threat",
  "hate",
  "self_harm",
  "illicit",
  "spam",
  "other_policy",
  "age_gate_required",
  "provider_unavailable",
  "provider_timeout",
  "provider_invalid",
]);
export type TextModerationReasonCode = Schema.Schema.Type<typeof TextModerationReasonCode>;

const ProviderReasonCodes = new Set<TextModerationReasonCode>([
  "provider_unavailable",
  "provider_timeout",
  "provider_invalid",
]);

export const TextModerationEvaluationV1 = Schema.Struct({
  version: Schema.Literal("text-moderation-v1"),
  surface: TextModerationSurface,
  decision: TextPublicationDecision,
  reason_codes: Schema.Array(TextModerationReasonCode),
  policy_revision: CanonicalIdentifier,
  policy_hash: Sha256Hex,
  input_sha256: Sha256Hex,
  evidence_ref: Schema.NullOr(CanonicalIdentifier),
}).check(
  Schema.makeFilter((evaluation) => {
    if (new Set(evaluation.reason_codes).size !== evaluation.reason_codes.length) {
      return "Expected unique moderation reason codes";
    }
    if (evaluation.decision === "allow") {
      return evaluation.reason_codes.length === 0
        ? undefined
        : "Allow decisions cannot contain reasons";
    }
    if (evaluation.reason_codes.length === 0) {
      return "Non-allow decisions require a reason";
    }
    if (evaluation.reason_codes.includes("sexual_minors")) {
      return evaluation.decision === "blocked" ? undefined : "sexual_minors must be blocked";
    }
    if (
      evaluation.reason_codes.includes("age_gate_required") ||
      evaluation.reason_codes.some((reason) => ProviderReasonCodes.has(reason))
    ) {
      return evaluation.decision === "manual_review"
        ? undefined
        : "Provider and age-gate reasons must be held for review";
    }
    return undefined;
  }),
);
export type TextModerationEvaluationV1 = Schema.Schema.Type<typeof TextModerationEvaluationV1>;

const MatchedCategoryDecisionsV1 = Schema.Record(
  ModerationPolicyCategoryV1,
  Schema.optional(ModerationPolicyDecisionV1),
);

export const TextModerationEvaluationV2 = Schema.Struct({
  version: Schema.Literal("text-moderation-v2"),
  surface: TextModerationSurface,
  decision: TextPublicationDecision,
  reason_codes: Schema.Array(TextModerationReasonCode),
  policy_revision: CanonicalIdentifier,
  policy_hash: Sha256Hex,
  platform_policy_revision: CanonicalIdentifier,
  platform_policy_hash: Sha256Hex,
  community_policy_revision: CanonicalIdentifier,
  community_policy_hash: Sha256Hex,
  matched_categories: Schema.Array(ModerationPolicyCategoryV1),
  category_decisions: MatchedCategoryDecisionsV1,
  effective_policy_decision: ModerationPolicyDecisionV1,
  author_declared_rating: ContentRatingV1,
  resulting_content_rating: ContentRatingV1,
  input_sha256: Sha256Hex,
  evidence_ref: Schema.NullOr(CanonicalIdentifier),
}).check(
  Schema.makeFilter((evaluation) => {
    if (new Set(evaluation.reason_codes).size !== evaluation.reason_codes.length) {
      return "Expected unique moderation reason codes";
    }
    if (new Set(evaluation.matched_categories).size !== evaluation.matched_categories.length) {
      return "Expected unique moderation categories";
    }
    const decisionKeys = Object.keys(evaluation.category_decisions);
    if (
      decisionKeys.length !== evaluation.matched_categories.length ||
      evaluation.matched_categories.some(
        (category) => evaluation.category_decisions[category] === undefined,
      )
    ) {
      return "Expected one policy decision per matched category";
    }
    if (evaluation.decision === "allow") {
      return evaluation.reason_codes.length === 0 &&
        evaluation.effective_policy_decision === "permit"
        ? undefined
        : "Allow decisions require a permitted policy result without reasons";
    }
    if (evaluation.reason_codes.length === 0) {
      return "Non-allow decisions require a reason";
    }
    if (evaluation.effective_policy_decision === "block") {
      return evaluation.decision === "blocked"
        ? undefined
        : "Blocked policy results must block publication";
    }
    return evaluation.decision === "manual_review"
      ? undefined
      : "Review policy results must hold publication";
  }),
);
export type TextModerationEvaluationV2 = Schema.Schema.Type<typeof TextModerationEvaluationV2>;

export const TextModerationEvaluation = Schema.Union([
  TextModerationEvaluationV1,
  TextModerationEvaluationV2,
]);
export type TextModerationEvaluation = Schema.Schema.Type<typeof TextModerationEvaluation>;

export const PublicTextModerationReasonCode = Schema.Literals([
  "policy_violation",
  "review_required",
  "moderation_unavailable",
]);
export type PublicTextModerationReasonCode = Schema.Schema.Type<
  typeof PublicTextModerationReasonCode
>;

export const PublicTextPublicationResultV1 = Schema.Union([
  Schema.Struct({ decision: Schema.Literal("allow"), reason_code: Schema.Null }),
  Schema.Struct({
    decision: Schema.Literal("manual_review"),
    reason_code: Schema.Literals(["review_required", "moderation_unavailable"]),
  }),
  Schema.Struct({
    decision: Schema.Literal("blocked"),
    reason_code: Schema.Literal("policy_violation"),
  }),
]);
export type PublicTextPublicationResultV1 = Schema.Schema.Type<
  typeof PublicTextPublicationResultV1
>;

export const PublishedTextResourceV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("post"),
    post_id: CanonicalIdentifier,
    href: SameOriginHref,
  }),
  Schema.Struct({
    kind: Schema.Literal("comment"),
    comment_id: CanonicalIdentifier,
    href: SameOriginHref,
  }),
]);
export type PublishedTextResourceV1 = Schema.Schema.Type<typeof PublishedTextResourceV1>;

export const TextContentSubmissionV1 = Schema.Struct({
  submission_id: CanonicalIdentifier,
  href: SameOriginHref,
  surface: TextModerationSurface,
  status: Schema.Literals(["published", "manual_review", "blocked"]),
  result: PublicTextPublicationResultV1,
  published_resource: Schema.NullOr(PublishedTextResourceV1),
  review_ref: Schema.NullOr(CanonicalIdentifier),
  created_at: CanonicalIsoInstant,
  updated_at: CanonicalIsoInstant,
}).check(
  Schema.makeFilter((submission) => {
    if (submission.status === "published") {
      if (
        submission.result.decision !== "allow" ||
        submission.published_resource === null ||
        submission.review_ref !== null
      ) {
        return "Published submissions require an allow result and published resource";
      }
      if (submission.surface === "text_post") {
        return submission.published_resource.kind === "post"
          ? undefined
          : "Text-post submissions require a post resource";
      }
      return submission.published_resource.kind === "comment"
        ? undefined
        : "Comment and reply submissions require a comment resource";
    }
    if (submission.published_resource !== null) {
      return "Unpublished submissions cannot expose a published resource";
    }
    if (submission.status === "manual_review") {
      return submission.result.decision === "manual_review" && submission.review_ref !== null
        ? undefined
        : "Manual-review submissions require a review result and reference";
    }
    return submission.result.decision === "blocked" && submission.review_ref === null
      ? undefined
      : "Blocked submissions require a blocked result and no references";
  }),
);
export type TextContentSubmissionV1 = Schema.Schema.Type<typeof TextContentSubmissionV1>;
