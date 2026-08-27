import { describe, expect, test } from "bun:test";
import {
  INITIAL_COMMUNITY_MODERATION_POLICY_V1,
  MODERATION_PLATFORM_FLOOR_V1,
} from "@pirate/domain";
import { Effect } from "effect";
import { TextModerationProviderError } from "./ports.ts";
import {
  evaluateTextModerationV2,
  type TextModerationPolicySnapshotV2,
  type TextModerationProviderEvaluationV1,
} from "./text-moderation-runtime.ts";

const input = {
  version: "text-moderation-input-v1",
  surface: "text_post",
  title: null,
  body: "moderated text",
} as const;
const inputSha256 = "d".repeat(64);
const snapshot: TextModerationPolicySnapshotV2 = {
  policy_revision: "provider-v2",
  policy_hash: "a".repeat(64),
  platform_policy_revision: "floor-v1",
  platform_policy_hash: "b".repeat(64),
  platform_policy: MODERATION_PLATFORM_FLOOR_V1,
  community_policy_revision: "community-v1",
  community_policy_hash: "c".repeat(64),
  community_policy: INITIAL_COMMUNITY_MODERATION_POLICY_V1,
};
const emptyCategories = Object.fromEntries(
  Object.keys(MODERATION_PLATFORM_FLOOR_V1).map((category) => [category, false]),
) as TextModerationProviderEvaluationV1["inputs"][number]["categories"];
const emptyScores = Object.fromEntries(
  Object.keys(MODERATION_PLATFORM_FLOOR_V1).map((category) => [category, 0]),
) as TextModerationProviderEvaluationV1["inputs"][number]["scores"];
const textTypes = Object.fromEntries(
  Object.keys(MODERATION_PLATFORM_FLOOR_V1).map((category) => [category, ["text"]]),
) as unknown as TextModerationProviderEvaluationV1["inputs"][number]["applied_input_types"];

const providerResult = (
  matched_categories: TextModerationProviderEvaluationV1["matched_categories"],
): TextModerationProviderEvaluationV1 => ({
  provider_id: "openai",
  requested_model: "omni-moderation-2024-09-26",
  returned_model: "omni-moderation-2024-09-26",
  input_sha256: inputSha256,
  matched_categories,
  inputs: [
    {
      input_sha256: "e".repeat(64),
      categories: Object.fromEntries(
        Object.entries(emptyCategories).map(([category]) => [
          category,
          matched_categories.includes(category as (typeof matched_categories)[number]),
        ]),
      ) as typeof emptyCategories,
      scores: emptyScores,
      applied_input_types: textTypes,
    },
  ],
});

const store = {
  readModerationPolicy: () => Effect.succeed(snapshot),
};

describe("text moderation V2 runtime", () => {
  test("resolves Boolean category matches through the current community policy", async () => {
    const result = await Effect.runPromise(
      evaluateTextModerationV2({
        communityId: "community-1",
        moderationInput: input,
        inputSha256,
        store,
        provider: { evaluate: () => Effect.succeed(providerResult(["harassment"])) },
      }),
    );
    expect(result.evaluation).toMatchObject({
      version: "text-moderation-v2",
      decision: "manual_review",
      reason_codes: ["harassment"],
      category_decisions: { harassment: "review" },
      policy_revision: "provider-v2",
      platform_policy_revision: "floor-v1",
      community_policy_revision: "community-v1",
    });
    expect(result.restrictedEvidence).toMatchObject({
      community_id: "community-1",
      requested_model: "omni-moderation-2024-09-26",
      input_sha256: inputSha256,
    });
    const evidence = result.restrictedEvidence;
    if (evidence === undefined) throw new Error("expected restricted evidence");
    expect(result.evaluation.evidence_ref).toBe(evidence.evidence_ref);
  });

  test("blocks sexual minors and rates permitted sexual content adult-only", async () => {
    const blocked = await Effect.runPromise(
      evaluateTextModerationV2({
        communityId: "community-1",
        moderationInput: input,
        inputSha256,
        store,
        provider: { evaluate: () => Effect.succeed(providerResult(["sexual/minors"])) },
      }),
    );
    expect(blocked.evaluation).toMatchObject({
      decision: "blocked",
      reason_codes: ["sexual_minors"],
    });

    const permittedStore: typeof store = {
      readModerationPolicy: () =>
        Effect.succeed({
          ...snapshot,
          community_policy: {
            ...INITIAL_COMMUNITY_MODERATION_POLICY_V1,
            sexual: "permit",
          } as const,
        }),
    };
    const permitted = await Effect.runPromise(
      evaluateTextModerationV2({
        communityId: "community-1",
        moderationInput: input,
        inputSha256,
        store: permittedStore,
        provider: { evaluate: () => Effect.succeed(providerResult(["sexual"])) },
      }),
    );
    expect(permitted.evaluation).toMatchObject({
      decision: "allow",
      resulting_content_rating: "adult_18",
      reason_codes: [],
    });
  });

  test("turns every provider failure into V2 manual review without evidence", async () => {
    for (const reason of ["unavailable", "timeout", "invalid"] as const) {
      const result = await Effect.runPromise(
        evaluateTextModerationV2({
          communityId: "community-1",
          moderationInput: input,
          inputSha256,
          authorDeclaredRating: "adult_18",
          store,
          provider: {
            evaluate: () => Effect.fail(new TextModerationProviderError({ reason })),
          },
        }),
      );
      expect(result.evaluation).toMatchObject({
        version: "text-moderation-v2",
        decision: "manual_review",
        effective_policy_decision: "review",
        author_declared_rating: "adult_18",
        resulting_content_rating: "adult_18",
        evidence_ref: null,
      });
      expect(result.evaluation.reason_codes).toEqual([`provider_${reason}`]);
      expect(result.restrictedEvidence).toBeUndefined();
    }
  });
});
