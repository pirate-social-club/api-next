import { sha256Hex } from "../gates-v2/sha256.ts";
import type {
  ContentRatingV1,
  ModerationPolicyCategoryV1,
  ModerationPolicyDecisionV1,
} from "./community-moderation-policy.ts";

export type TextPublicationDecision = "allow" | "manual_review" | "blocked";
export type TextModerationSurface = "text_post" | "comment" | "reply";

export type TextModerationInputV1 = Readonly<{
  readonly version: "text-moderation-input-v1";
  readonly surface: TextModerationSurface;
  readonly title: string | null;
  readonly body: string | null;
}>;

export const TEXT_MODERATION_REASON_CODES = [
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
] as const;

export type TextModerationReasonCode = (typeof TEXT_MODERATION_REASON_CODES)[number];

export type TextModerationEvaluationV1 = Readonly<{
  readonly version: "text-moderation-v1";
  readonly surface: TextModerationSurface;
  readonly decision: TextPublicationDecision;
  readonly reason_codes: readonly TextModerationReasonCode[];
  readonly policy_revision: string;
  readonly policy_hash: string;
  readonly input_sha256: string;
  readonly evidence_ref: string | null;
}>;

export type TextModerationEvaluationV2 = Readonly<{
  readonly version: "text-moderation-v2";
  readonly surface: TextModerationSurface;
  readonly decision: TextPublicationDecision;
  readonly reason_codes: readonly TextModerationReasonCode[];
  readonly policy_revision: string;
  readonly policy_hash: string;
  readonly platform_policy_revision: string;
  readonly platform_policy_hash: string;
  readonly community_policy_revision: string;
  readonly community_policy_hash: string;
  readonly matched_categories: readonly ModerationPolicyCategoryV1[];
  readonly category_decisions: Readonly<{
    readonly [K in ModerationPolicyCategoryV1]?: ModerationPolicyDecisionV1 | undefined;
  }>;
  readonly effective_policy_decision: ModerationPolicyDecisionV1;
  readonly author_declared_rating: ContentRatingV1;
  readonly resulting_content_rating: ContentRatingV1;
  readonly input_sha256: string;
  readonly evidence_ref: string | null;
}>;

export type TextModerationEvaluation = TextModerationEvaluationV1 | TextModerationEvaluationV2;

export type PublicTextPublicationResultV1 =
  | Readonly<{ readonly decision: "allow"; readonly reason_code: null }>
  | Readonly<{
      readonly decision: "manual_review";
      readonly reason_code: "review_required" | "moderation_unavailable";
    }>
  | Readonly<{ readonly decision: "blocked"; readonly reason_code: "policy_violation" }>;

export type PublishedTextResourceV1 =
  | Readonly<{ readonly kind: "post"; readonly post_id: string; readonly href: string }>
  | Readonly<{ readonly kind: "comment"; readonly comment_id: string; readonly href: string }>;

export type TextContentSubmissionV1 = Readonly<{
  readonly submission_id: string;
  readonly href: string;
  readonly surface: TextModerationSurface;
  readonly status: "published" | "manual_review" | "blocked";
  readonly result: PublicTextPublicationResultV1;
  readonly published_resource: PublishedTextResourceV1 | null;
  readonly review_ref: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}>;

export type NormalizeTextModerationInputResult =
  | Readonly<{ readonly kind: "accepted"; readonly input: TextModerationInputV1 }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason: "empty" | "invalid_surface" | "invalid_unicode";
    }>;

export type CanonicalTextModerationInputResult =
  | Readonly<{ readonly kind: "accepted"; readonly preimage: string; readonly sha256: string }>
  | Readonly<{
      readonly kind: "rejected";
      readonly reason:
        | "empty"
        | "invalid_body"
        | "invalid_surface"
        | "invalid_title"
        | "invalid_version";
    }>;

const SHA256_HEX = /^[0-9a-f]{64}$/u;
const CANONICAL_ISO_INSTANT =
  /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])T(?:[01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$/u;
const PROVIDER_REASON_CODES = new Set<TextModerationReasonCode>([
  "provider_unavailable",
  "provider_timeout",
  "provider_invalid",
]);
const TEXT_MODERATION_REASON_CODE_SET = new Set<string>(TEXT_MODERATION_REASON_CODES);
const TEXT_MODERATION_SURFACES = new Set<string>(["text_post", "comment", "reply"]);
const INVALID_UNICODE = Symbol("invalid_unicode");

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

function normalizeField(value: string | null | undefined): string | null | typeof INVALID_UNICODE {
  if (value === null || value === undefined) return null;
  if (hasLoneSurrogate(value)) return INVALID_UNICODE;
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n").normalize("NFC").trim();
  return normalized.length === 0 ? null : normalized;
}

function canonicalField(value: string | null): boolean {
  return (
    value === null ||
    (value.length > 0 &&
      value.trim() === value &&
      !value.includes("\r") &&
      value.normalize("NFC") === value &&
      !hasLoneSurrogate(value))
  );
}

function isTextModerationSurface(value: unknown): value is TextModerationSurface {
  return typeof value === "string" && TEXT_MODERATION_SURFACES.has(value);
}

function sameOriginPath(value: string): boolean {
  return (
    nonEmpty(value) && value.startsWith("/") && !value.startsWith("//") && !value.includes("\\")
  );
}

export function normalizeTextModerationInput(
  input: Readonly<{
    readonly surface: TextModerationSurface;
    readonly title?: string | null;
    readonly body?: string | null;
  }>,
): NormalizeTextModerationInputResult {
  if (!isTextModerationSurface(input.surface)) {
    return { kind: "rejected", reason: "invalid_surface" };
  }
  const title = normalizeField(input.title);
  const body = normalizeField(input.body);
  if (title === INVALID_UNICODE || body === INVALID_UNICODE) {
    return { kind: "rejected", reason: "invalid_unicode" };
  }
  if (title === null && body === null) return { kind: "rejected", reason: "empty" };
  return {
    kind: "accepted",
    input: {
      version: "text-moderation-input-v1",
      surface: input.surface,
      title,
      body,
    },
  };
}

/** RFC 8785 JCS for this closed string/null-only object. */
export function canonicalTextModerationInput(
  input: TextModerationInputV1,
): CanonicalTextModerationInputResult {
  if (input.version !== "text-moderation-input-v1") {
    return { kind: "rejected", reason: "invalid_version" };
  }
  if (!isTextModerationSurface(input.surface)) {
    return { kind: "rejected", reason: "invalid_surface" };
  }
  if (!canonicalField(input.title)) return { kind: "rejected", reason: "invalid_title" };
  if (!canonicalField(input.body)) return { kind: "rejected", reason: "invalid_body" };
  if (input.title === null && input.body === null) return { kind: "rejected", reason: "empty" };
  const preimage = JSON.stringify({
    body: input.body,
    surface: input.surface,
    title: input.title,
    version: input.version,
  });
  return { kind: "accepted", preimage, sha256: sha256Hex(preimage) };
}

export function canonicalTextModerationReasons(
  reasons: readonly unknown[],
): readonly TextModerationReasonCode[] {
  const present = new Set<TextModerationReasonCode>();
  let invalid = false;
  for (const reason of reasons) {
    if (typeof reason === "string" && TEXT_MODERATION_REASON_CODE_SET.has(reason)) {
      present.add(reason as TextModerationReasonCode);
    } else {
      invalid = true;
    }
  }
  if (invalid) present.add("provider_invalid");
  return TEXT_MODERATION_REASON_CODES.filter((reason) => present.has(reason));
}

export function baselineTextModerationDecision(
  reasons: readonly unknown[],
): TextPublicationDecision {
  const canonicalReasons = canonicalTextModerationReasons(reasons);
  if (canonicalReasons.includes("sexual_minors")) return "blocked";
  return canonicalReasons.length === 0 ? "allow" : "manual_review";
}

export function moreRestrictiveTextPublicationDecision(
  baseline: TextPublicationDecision,
  overlay: TextPublicationDecision,
): TextPublicationDecision {
  const severity: Readonly<Record<TextPublicationDecision, number>> = {
    allow: 1,
    manual_review: 2,
    blocked: 3,
  };
  return severity[baseline] >= severity[overlay] ? baseline : overlay;
}

export function textModerationEvaluationInvariant(
  evaluation: TextModerationEvaluation,
): string | null {
  if (evaluation.version !== "text-moderation-v1" && evaluation.version !== "text-moderation-v2") {
    return "version";
  }
  if (!isTextModerationSurface(evaluation.surface)) return "surface";
  if (
    evaluation.policy_revision.length === 0 ||
    evaluation.policy_revision.trim() !== evaluation.policy_revision
  ) {
    return "policy_revision";
  }
  if (!SHA256_HEX.test(evaluation.policy_hash)) return "policy_hash";
  if (!SHA256_HEX.test(evaluation.input_sha256)) return "input_sha256";
  if (evaluation.evidence_ref !== null && !nonEmpty(evaluation.evidence_ref)) {
    return "evidence_ref";
  }
  if (evaluation.version === "text-moderation-v2") {
    if (!nonEmpty(evaluation.platform_policy_revision)) return "platform_policy_revision";
    if (!SHA256_HEX.test(evaluation.platform_policy_hash)) return "platform_policy_hash";
    if (!nonEmpty(evaluation.community_policy_revision)) return "community_policy_revision";
    if (!SHA256_HEX.test(evaluation.community_policy_hash)) return "community_policy_hash";
    if (new Set(evaluation.matched_categories).size !== evaluation.matched_categories.length) {
      return "duplicate_matched_categories";
    }
    const decisionKeys = Object.keys(evaluation.category_decisions);
    if (
      decisionKeys.length !== evaluation.matched_categories.length ||
      evaluation.matched_categories.some(
        (category) => evaluation.category_decisions[category] === undefined,
      )
    ) {
      return "category_decisions";
    }
    const expectedDecision: TextPublicationDecision =
      evaluation.effective_policy_decision === "permit"
        ? "allow"
        : evaluation.effective_policy_decision === "review"
          ? "manual_review"
          : "blocked";
    if (evaluation.decision !== expectedDecision) return "effective_policy_decision";
  }
  if (new Set(evaluation.reason_codes).size !== evaluation.reason_codes.length) {
    return "duplicate_reason_codes";
  }
  if (evaluation.reason_codes.some((reason) => !TEXT_MODERATION_REASON_CODES.includes(reason))) {
    return "reason_codes";
  }
  if (evaluation.decision === "allow") {
    return evaluation.reason_codes.length === 0 ? null : "allow_with_reasons";
  }
  if (evaluation.reason_codes.length === 0) return "non_allow_without_reason";
  if (evaluation.reason_codes.includes("sexual_minors")) {
    return evaluation.decision === "blocked" ? null : "sexual_minors_not_blocked";
  }
  if (
    evaluation.reason_codes.includes("age_gate_required") ||
    evaluation.reason_codes.some((reason) => PROVIDER_REASON_CODES.has(reason))
  ) {
    return evaluation.decision === "manual_review" ? null : "review_reason_not_held";
  }
  return null;
}

export function publicTextPublicationResult(
  evaluation: TextModerationEvaluation,
): PublicTextPublicationResultV1 | null {
  if (textModerationEvaluationInvariant(evaluation) !== null) return null;
  if (evaluation.decision === "allow") return { decision: "allow", reason_code: null };
  if (evaluation.decision === "blocked") {
    return { decision: "blocked", reason_code: "policy_violation" };
  }
  return {
    decision: "manual_review",
    reason_code: evaluation.reason_codes.some((reason) => PROVIDER_REASON_CODES.has(reason))
      ? "moderation_unavailable"
      : "review_required",
  };
}

function canonicalInstant(value: string): boolean {
  if (!CANONICAL_ISO_INSTANT.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function nonEmpty(value: string): boolean {
  return value.length > 0 && value.trim() === value;
}

export function textContentSubmissionInvariant(submission: TextContentSubmissionV1): string | null {
  if (!nonEmpty(submission.submission_id)) return "submission_id";
  if (!sameOriginPath(submission.href)) return "href";
  if (!canonicalInstant(submission.created_at) || !canonicalInstant(submission.updated_at)) {
    return "timestamp";
  }
  const expectedStatus =
    submission.result.decision === "allow" ? "published" : submission.result.decision;
  if (submission.status !== expectedStatus) {
    return "status_result";
  }
  if (submission.status === "published") {
    if (submission.published_resource === null || submission.review_ref !== null) {
      return "published_references";
    }
    if (submission.surface === "text_post" && submission.published_resource.kind !== "post") {
      return "published_resource_surface";
    }
    if (submission.surface !== "text_post" && submission.published_resource.kind !== "comment") {
      return "published_resource_surface";
    }
    const resourceId =
      submission.published_resource.kind === "post"
        ? submission.published_resource.post_id
        : submission.published_resource.comment_id;
    if (!nonEmpty(resourceId)) return "published_resource_id";
    return sameOriginPath(submission.published_resource.href) ? null : "published_resource";
  }
  if (submission.published_resource !== null) return "unexpected_published_resource";
  if (submission.status === "manual_review") {
    return submission.review_ref !== null && nonEmpty(submission.review_ref) ? null : "review_ref";
  }
  return submission.review_ref === null ? null : "unexpected_review_ref";
}
