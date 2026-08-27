import type {
  ContentRatingV1,
  ModerationPolicyCategoryV1,
  ModerationPolicyDecisionV1,
  ModerationPolicyTableV1,
  TextModerationEvaluation,
  TextModerationEvaluationV2,
  TextModerationInputV1,
  TextModerationReasonCode,
} from "@pirate/contracts";
import { canonicalTextModerationReasons, resolveCommunityModerationPolicy } from "@pirate/domain";
import { Effect } from "effect";
import type {
  TextModerationProviderError,
  TextPostRepositoryFailure,
  TextPostStoreService,
} from "./ports.ts";

export type TextModerationInputType = "text" | "image";

export type NormalizedModerationInputEvidenceV1 = Readonly<{
  readonly input_sha256: string;
  readonly categories: Readonly<Record<ModerationPolicyCategoryV1, boolean>>;
  readonly scores: Readonly<Record<ModerationPolicyCategoryV1, number>>;
  readonly applied_input_types: Readonly<
    Record<ModerationPolicyCategoryV1, readonly TextModerationInputType[]>
  >;
}>;

export type TextModerationProviderEvaluationV1 = Readonly<{
  readonly provider_id: "openai";
  readonly requested_model: string;
  readonly returned_model: string;
  readonly input_sha256: string;
  readonly matched_categories: readonly ModerationPolicyCategoryV1[];
  readonly inputs: readonly NormalizedModerationInputEvidenceV1[];
}>;

export interface TextModerationProviderServiceV1 {
  readonly evaluate: (
    input: TextModerationInputV1,
  ) => Effect.Effect<TextModerationProviderEvaluationV1, TextModerationProviderError>;
}

export type TextModerationPolicySnapshotV2 = Readonly<{
  readonly policy_revision: string;
  readonly policy_hash: string;
  readonly platform_policy_revision: string;
  readonly platform_policy_hash: string;
  readonly platform_policy: ModerationPolicyTableV1;
  readonly community_policy_revision: string;
  readonly community_policy_hash: string;
  readonly community_policy: ModerationPolicyTableV1;
}>;

export type RestrictedTextModerationEvidenceV1 = Readonly<{
  readonly evidence_ref: string;
  readonly evidence_hash: string;
  readonly provider_id: "openai";
  readonly requested_model: string;
  readonly returned_model: string;
  readonly input_sha256: string;
  readonly community_id: string;
  readonly policy_revision: string;
  readonly policy_hash: string;
  readonly platform_policy_revision: string;
  readonly platform_policy_hash: string;
  readonly community_policy_revision: string;
  readonly community_policy_hash: string;
  readonly inputs: readonly NormalizedModerationInputEvidenceV1[];
}>;

type LegacyCommitInput = Parameters<TextPostStoreService["commitTerminal"]>[0];

export type TextPostCommitInputV2 = Omit<LegacyCommitInput, "evaluation"> &
  Readonly<{
    readonly evaluation: TextModerationEvaluation;
    readonly restrictedEvidence?: RestrictedTextModerationEvidenceV1;
  }>;

export type TextPostStoreServiceV2 = Omit<TextPostStoreService, "commitTerminal"> &
  Readonly<{
    readonly readModerationPolicy: (input: {
      readonly communityId: string;
    }) => Effect.Effect<TextModerationPolicySnapshotV2, TextPostRepositoryFailure>;
    readonly commitTerminal: (
      input: TextPostCommitInputV2,
    ) => ReturnType<TextPostStoreService["commitTerminal"]>;
  }>;

export type TextModerationRuntimeResultV2 = Readonly<{
  readonly evaluation: TextModerationEvaluationV2;
  readonly restrictedEvidence?: RestrictedTextModerationEvidenceV1;
}>;

const categoryReason = (category: ModerationPolicyCategoryV1): TextModerationReasonCode => {
  switch (category) {
    case "sexual/minors":
      return "sexual_minors";
    case "sexual":
      return "adult_sexual";
    case "violence/graphic":
      return "graphic_violence";
    case "harassment":
      return "harassment";
    case "harassment/threatening":
      return "threat";
    case "hate":
    case "hate/threatening":
      return "hate";
    case "self-harm":
    case "self-harm/intent":
    case "self-harm/instructions":
      return "self_harm";
    case "illicit":
    case "illicit/violent":
      return "illicit";
    case "violence":
      return "other_policy";
  }
};

const policyDecision = (
  decision: ModerationPolicyDecisionV1,
): "allow" | "manual_review" | "blocked" =>
  decision === "permit" ? "allow" : decision === "review" ? "manual_review" : "blocked";

const digestHex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const restrictedEvidence = async (
  provider: TextModerationProviderEvaluationV1,
  policy: TextModerationPolicySnapshotV2,
  communityId: string,
): Promise<RestrictedTextModerationEvidenceV1> => {
  const preimage = JSON.stringify([
    "text-moderation-restricted-evidence-v1",
    provider.provider_id,
    provider.requested_model,
    provider.returned_model,
    provider.input_sha256,
    communityId,
    policy.policy_revision,
    policy.policy_hash,
    policy.platform_policy_revision,
    policy.platform_policy_hash,
    policy.community_policy_revision,
    policy.community_policy_hash,
    provider.inputs,
  ]);
  const evidenceHash = await digestHex(preimage);
  return {
    evidence_ref: `evidence_${evidenceHash}`,
    evidence_hash: evidenceHash,
    provider_id: provider.provider_id,
    requested_model: provider.requested_model,
    returned_model: provider.returned_model,
    input_sha256: provider.input_sha256,
    community_id: communityId,
    policy_revision: policy.policy_revision,
    policy_hash: policy.policy_hash,
    platform_policy_revision: policy.platform_policy_revision,
    platform_policy_hash: policy.platform_policy_hash,
    community_policy_revision: policy.community_policy_revision,
    community_policy_hash: policy.community_policy_hash,
    inputs: provider.inputs,
  };
};

const unavailableEvaluation = (
  input: TextModerationInputV1,
  inputSha256: string,
  policy: TextModerationPolicySnapshotV2,
  reason: TextModerationProviderError["reason"],
  authorDeclaredRating: ContentRatingV1,
): TextModerationEvaluationV2 => ({
  version: "text-moderation-v2",
  surface: input.surface,
  decision: "manual_review",
  reason_codes: [
    reason === "unavailable"
      ? "provider_unavailable"
      : reason === "timeout"
        ? "provider_timeout"
        : "provider_invalid",
  ],
  policy_revision: policy.policy_revision,
  policy_hash: policy.policy_hash,
  platform_policy_revision: policy.platform_policy_revision,
  platform_policy_hash: policy.platform_policy_hash,
  community_policy_revision: policy.community_policy_revision,
  community_policy_hash: policy.community_policy_hash,
  matched_categories: [],
  category_decisions: {},
  effective_policy_decision: "review",
  author_declared_rating: authorDeclaredRating,
  resulting_content_rating: authorDeclaredRating,
  input_sha256: inputSha256,
  evidence_ref: null,
});

export const evaluateTextModerationV2 = Effect.fn("evaluateTextModerationV2")(function* (input: {
  readonly communityId: string;
  readonly moderationInput: TextModerationInputV1;
  readonly inputSha256: string;
  readonly authorDeclaredRating?: ContentRatingV1;
  readonly store: Pick<TextPostStoreServiceV2, "readModerationPolicy">;
  readonly provider: TextModerationProviderServiceV1;
}): Effect.fn.Return<TextModerationRuntimeResultV2, TextPostRepositoryFailure> {
  const policy = yield* input.store.readModerationPolicy({ communityId: input.communityId });
  const provider = yield* input.provider.evaluate(input.moderationInput).pipe(
    Effect.map((evaluation) => ({ kind: "evaluated" as const, evaluation })),
    Effect.catchTag("TextModerationProviderError", (failure) =>
      Effect.succeed({ kind: "failed" as const, failure }),
    ),
    Effect.catchDefect(() =>
      Effect.succeed({
        kind: "failed" as const,
        failure: { reason: "invalid" as const },
      }),
    ),
  );
  if (provider.kind === "failed") {
    return {
      evaluation: unavailableEvaluation(
        input.moderationInput,
        input.inputSha256,
        policy,
        provider.failure.reason,
        input.authorDeclaredRating ?? "general",
      ),
    };
  }
  if (provider.evaluation.input_sha256 !== input.inputSha256) {
    return {
      evaluation: unavailableEvaluation(
        input.moderationInput,
        input.inputSha256,
        policy,
        "invalid",
        input.authorDeclaredRating ?? "general",
      ),
    };
  }
  const resolution = resolveCommunityModerationPolicy({
    platform_floor: policy.platform_policy,
    community_policy: policy.community_policy,
    matched_categories: provider.evaluation.matched_categories,
    author_declared_rating: input.authorDeclaredRating ?? "general",
  });
  const decision = policyDecision(resolution.effective_policy_decision);
  const reasons =
    decision === "allow"
      ? []
      : canonicalTextModerationReasons(
          resolution.matched_categories
            .filter((category) => resolution.category_decisions[category] !== "permit")
            .map(categoryReason),
        );
  const reasonCodes: readonly TextModerationReasonCode[] =
    reasons.length === 0 && decision !== "allow" ? ["other_policy"] : reasons;
  const evidence = yield* Effect.promise(() =>
    restrictedEvidence(provider.evaluation, policy, input.communityId),
  );
  return {
    evaluation: {
      version: "text-moderation-v2",
      surface: input.moderationInput.surface,
      decision,
      reason_codes: reasonCodes,
      policy_revision: policy.policy_revision,
      policy_hash: policy.policy_hash,
      platform_policy_revision: policy.platform_policy_revision,
      platform_policy_hash: policy.platform_policy_hash,
      community_policy_revision: policy.community_policy_revision,
      community_policy_hash: policy.community_policy_hash,
      matched_categories: resolution.matched_categories,
      category_decisions: resolution.category_decisions,
      effective_policy_decision: resolution.effective_policy_decision,
      author_declared_rating: input.authorDeclaredRating ?? "general",
      resulting_content_rating: resolution.resulting_content_rating,
      input_sha256: input.inputSha256,
      evidence_ref: evidence.evidence_ref,
    },
    restrictedEvidence: evidence,
  };
});
