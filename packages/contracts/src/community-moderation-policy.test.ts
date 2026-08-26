import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CONTENT_RATINGS_V1,
  MODERATION_POLICY_CATEGORIES_V1,
  ModerationPolicyResolutionV1,
  ModerationPolicyResolverInputV1,
  ModerationPolicyTableV1,
} from "./community-moderation-policy.ts";

const strict = { onExcessProperty: "error" } as const;

function completePolicy(decision: "permit" | "review" | "block") {
  return Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, decision]),
  ) as Record<(typeof MODERATION_POLICY_CATEGORIES_V1)[number], typeof decision>;
}

describe("community moderation policy contracts", () => {
  test("freezes the thirteen-category and two-rating closed sets", () => {
    expect(MODERATION_POLICY_CATEGORIES_V1).toHaveLength(13);
    expect(new Set(MODERATION_POLICY_CATEGORIES_V1).size).toBe(13);
    expect(MODERATION_POLICY_CATEGORIES_V1).toEqual([
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
    ]);
    expect(CONTENT_RATINGS_V1).toEqual(["general", "adult_18"]);
  });

  test("requires a complete exact policy table", () => {
    const decode = Schema.decodeUnknownSync(ModerationPolicyTableV1);
    const complete = completePolicy("review");
    expect(decode(complete, strict)).toEqual(complete);

    const { harassment: _omitted, ...incomplete } = complete;
    for (const candidate of [
      incomplete,
      { ...complete, harassment: "allow" },
      { ...complete, provider_extension: "review" },
    ]) {
      expect(() => decode(candidate, strict)).toThrow();
    }
  });

  test("rejects unknown resolver input while accepting a closed resolution", () => {
    const decodeInput = Schema.decodeUnknownSync(ModerationPolicyResolverInputV1);
    const floor = completePolicy("permit");
    const community = completePolicy("review");
    expect(
      decodeInput(
        {
          platform_floor: floor,
          community_policy: community,
          matched_categories: ["harassment", "sexual"],
          author_declared_rating: "general",
        },
        strict,
      ),
    ).toMatchObject({ matched_categories: ["harassment", "sexual"] });

    expect(() =>
      decodeInput(
        {
          platform_floor: floor,
          community_policy: community,
          matched_categories: ["provider/future-category"],
          author_declared_rating: "general",
        },
        strict,
      ),
    ).toThrow();

    const decodeResolution = Schema.decodeUnknownSync(ModerationPolicyResolutionV1);
    expect(
      decodeResolution(
        {
          matched_categories: ["sexual"],
          category_decisions: { sexual: "permit" },
          effective_policy_decision: "permit",
          automated_rating: "adult_18",
          resulting_content_rating: "adult_18",
          fail_closed_reasons: [],
        },
        strict,
      ),
    ).toMatchObject({ resulting_content_rating: "adult_18" });
  });
});
