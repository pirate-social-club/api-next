import { describe, expect, test } from "bun:test";
import {
  MODERATION_PLATFORM_FLOOR_V1,
  MODERATION_POLICY_CATEGORIES_V1,
  MODERATION_RATING_RULE_V2,
  resolveCommunityModerationPolicy,
  resolveCommunityModerationPolicyV2,
} from "./community-moderation-policy.ts";

describe("accepted adult signal rating successor", () => {
  test("keeps permitted publication and raises reviewed or blocked adult signals without rewriting v1", () => {
    for (const category of ["sexual", "violence/graphic"] as const) {
      for (const decision of ["permit", "review", "block"] as const) {
        const input = {
          platform_floor: MODERATION_PLATFORM_FLOOR_V1,
          community_policy: { ...MODERATION_PLATFORM_FLOOR_V1, [category]: decision },
          matched_categories: [category],
          author_declared_rating: "general",
        };
        const historical = resolveCommunityModerationPolicy(input);
        const result = resolveCommunityModerationPolicyV2(input);
        expect(result.rating_rule_revision).toBe(MODERATION_RATING_RULE_V2);
        expect(result.effective_policy_decision).toBe(decision);
        expect(result.automated_rating).toBe("adult_18");
        expect(result.resulting_content_rating).toBe("adult_18");
        expect(historical.automated_rating).toBe(decision === "permit" ? "adult_18" : "general");
        expect(resolveCommunityModerationPolicy(input)).toEqual(historical);
      }
    }
  });

  test("other categories do not create an adult signal and the author floor survives", () => {
    for (const category of MODERATION_POLICY_CATEGORIES_V1) {
      if (category === "sexual" || category === "violence/graphic") continue;
      for (const rating of ["general", "adult_18"] as const) {
        const result = resolveCommunityModerationPolicyV2({
          platform_floor: MODERATION_PLATFORM_FLOOR_V1,
          community_policy: MODERATION_PLATFORM_FLOOR_V1,
          matched_categories: [category],
          author_declared_rating: rating,
        });
        expect(result.automated_rating).toBe("general");
        expect(result.resulting_content_rating).toBe(rating);
      }
    }
  });

  test("sexual minors is blocked even with a malformed or permissive floor", () => {
    for (const floor of [null, { ...MODERATION_PLATFORM_FLOOR_V1, "sexual/minors": "permit" }]) {
      const result = resolveCommunityModerationPolicyV2({
        platform_floor: floor,
        community_policy: { ...MODERATION_PLATFORM_FLOOR_V1, "sexual/minors": "permit" },
        matched_categories: ["sexual/minors", "sexual"],
        author_declared_rating: "general",
      });
      expect(result.category_decisions["sexual/minors"]).toBe("block");
      expect(result.effective_policy_decision).toBe("block");
      expect(result.resulting_content_rating).toBe("adult_18");
    }
  });

  test("invalid policy and unknown matches hold publication without clearing a retained adult signal", () => {
    const result = resolveCommunityModerationPolicyV2({
      platform_floor: null,
      community_policy: MODERATION_PLATFORM_FLOOR_V1,
      matched_categories: ["sexual", "future/category"],
      author_declared_rating: "general",
    });
    expect(result.effective_policy_decision).toBe("review");
    expect(result.resulting_content_rating).toBe("adult_18");
    expect(result.fail_closed_reasons).toEqual(["platform_floor_invalid", "unknown_category"]);
  });
});
