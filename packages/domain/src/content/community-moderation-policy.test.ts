import { describe, expect, test } from "bun:test";
import {
  INITIAL_COMMUNITY_MODERATION_POLICY_V1,
  MODERATION_PLATFORM_FLOOR_V1,
  MODERATION_POLICY_CATEGORIES_V1,
  type ModerationPolicyDecisionV1,
  type ModerationPolicyTableV1,
  resolveCommunityModerationPolicy,
} from "./community-moderation-policy.ts";

const severity: Readonly<Record<ModerationPolicyDecisionV1, number>> = {
  permit: 1,
  review: 2,
  block: 3,
};

function policy(decision: ModerationPolicyDecisionV1): ModerationPolicyTableV1 {
  return Object.fromEntries(
    MODERATION_POLICY_CATEGORIES_V1.map((category) => [category, decision]),
  ) as ModerationPolicyTableV1;
}

function expectedDecision(decisions: readonly ModerationPolicyDecisionV1[]) {
  return decisions.reduce((current, candidate) =>
    severity[current] >= severity[candidate] ? current : candidate,
  );
}

describe("community moderation policy resolver", () => {
  test("pins the platform floor and initial community policy", () => {
    expect(Object.keys(MODERATION_PLATFORM_FLOOR_V1)).toEqual([...MODERATION_POLICY_CATEGORIES_V1]);
    expect(MODERATION_PLATFORM_FLOOR_V1).toEqual({
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
    });
    for (const category of MODERATION_POLICY_CATEGORIES_V1) {
      expect(INITIAL_COMMUNITY_MODERATION_POLICY_V1[category]).toBe(
        category === "sexual/minors" ? "block" : "review",
      );
    }
  });

  test("clamps every category and community decision to the platform floor", () => {
    for (const category of MODERATION_POLICY_CATEGORIES_V1) {
      for (const communityDecision of ["permit", "review", "block"] as const) {
        const community = { ...policy("permit"), [category]: communityDecision };
        const result = resolveCommunityModerationPolicy({
          platform_floor: MODERATION_PLATFORM_FLOOR_V1,
          community_policy: community,
          matched_categories: [category],
          author_declared_rating: "general",
        });
        expect(result.category_decisions[category]).toBe(
          expectedDecision([MODERATION_PLATFORM_FLOOR_V1[category], communityDecision]),
        );
      }
    }
  });

  test("resolves every two- and three-category precedence combination", () => {
    const categories = ["harassment", "illicit", "self-harm"] as const;
    const decisions = ["permit", "review", "block"] as const;

    for (const first of decisions) {
      for (const second of decisions) {
        const community = { ...policy("permit"), harassment: first, illicit: second };
        expect(
          resolveCommunityModerationPolicy({
            platform_floor: policy("permit"),
            community_policy: community,
            matched_categories: categories.slice(0, 2),
            author_declared_rating: "general",
          }).effective_policy_decision,
        ).toBe(expectedDecision([first, second]));

        for (const third of decisions) {
          const triple = { ...community, "self-harm": third };
          expect(
            resolveCommunityModerationPolicy({
              platform_floor: policy("permit"),
              community_policy: triple,
              matched_categories: categories,
              author_declared_rating: "general",
            }).effective_policy_decision,
          ).toBe(expectedDecision([first, second, third]));
        }
      }
    }
  });

  test("clamps a stale weaker community revision against a strengthened floor", () => {
    const staleCommunity = { ...INITIAL_COMMUNITY_MODERATION_POLICY_V1, hate: "permit" as const };
    const strengthenedFloor = { ...MODERATION_PLATFORM_FLOOR_V1, hate: "block" as const };
    const result = resolveCommunityModerationPolicy({
      platform_floor: strengthenedFloor,
      community_policy: staleCommunity,
      matched_categories: ["hate"],
      author_declared_rating: "general",
    });
    expect(result.category_decisions).toEqual({ hate: "block" });
    expect(result.effective_policy_decision).toBe("block");
    expect(staleCommunity.hate).toBe("permit");
  });

  test("raises automated rating only for permitted sexual and graphic violence", () => {
    for (const category of MODERATION_POLICY_CATEGORIES_V1) {
      const floor = { ...policy("permit"), [category]: "permit" as const };
      const result = resolveCommunityModerationPolicy({
        platform_floor: floor,
        community_policy: policy("permit"),
        matched_categories: [category],
        author_declared_rating: "general",
      });
      expect(result.automated_rating).toBe(
        category === "sexual" || category === "violence/graphic" ? "adult_18" : "general",
      );
    }

    for (const category of ["sexual", "violence/graphic"] as const) {
      for (const decision of ["review", "block"] as const) {
        const result = resolveCommunityModerationPolicy({
          platform_floor: policy("permit"),
          community_policy: { ...policy("permit"), [category]: decision },
          matched_categories: [category],
          author_declared_rating: "general",
        });
        expect(result.automated_rating).toBe("general");
      }
    }
  });

  test("takes the maximum of author and automated ratings", () => {
    for (const author_declared_rating of ["general", "adult_18"] as const) {
      const result = resolveCommunityModerationPolicy({
        platform_floor: policy("permit"),
        community_policy: policy("permit"),
        matched_categories: ["harassment"],
        author_declared_rating,
      });
      expect(result.resulting_content_rating).toBe(author_declared_rating);
    }
    expect(
      resolveCommunityModerationPolicy({
        platform_floor: policy("permit"),
        community_policy: policy("permit"),
        matched_categories: ["sexual"],
        author_declared_rating: "general",
      }).resulting_content_rating,
    ).toBe("adult_18");
  });

  test("fails closed on unknown, incomplete, excess, and malformed input", () => {
    const { harassment: _missing, ...incompleteFloor } = MODERATION_PLATFORM_FLOOR_V1;
    const cases = [
      {
        platform_floor: incompleteFloor,
        community_policy: INITIAL_COMMUNITY_MODERATION_POLICY_V1,
        matched_categories: ["harassment"],
        author_declared_rating: "general",
        reason: "platform_floor_invalid",
      },
      {
        platform_floor: MODERATION_PLATFORM_FLOOR_V1,
        community_policy: { ...INITIAL_COMMUNITY_MODERATION_POLICY_V1, future: "review" },
        matched_categories: ["harassment"],
        author_declared_rating: "general",
        reason: "community_policy_invalid",
      },
      {
        platform_floor: MODERATION_PLATFORM_FLOOR_V1,
        community_policy: INITIAL_COMMUNITY_MODERATION_POLICY_V1,
        matched_categories: ["provider/future-category"],
        author_declared_rating: "general",
        reason: "unknown_category",
      },
      {
        platform_floor: MODERATION_PLATFORM_FLOOR_V1,
        community_policy: INITIAL_COMMUNITY_MODERATION_POLICY_V1,
        matched_categories: ["harassment"],
        author_declared_rating: "child",
        reason: "author_rating_invalid",
      },
    ] as const;

    for (const candidate of cases) {
      const result = resolveCommunityModerationPolicy(candidate);
      expect(result.effective_policy_decision).toBe("review");
      expect(result.fail_closed_reasons).toContain(candidate.reason);
    }
    expect(resolveCommunityModerationPolicy(cases[3]).resulting_content_rating).toBe("adult_18");
  });

  test("deduplicates known categories and lets an unknown match hold a known permit", () => {
    const result = resolveCommunityModerationPolicy({
      platform_floor: policy("permit"),
      community_policy: policy("permit"),
      matched_categories: ["sexual", "sexual", "provider/future-category"],
      author_declared_rating: "general",
    });
    expect(result.matched_categories).toEqual(["sexual"]);
    expect(result.category_decisions).toEqual({ sexual: "permit" });
    expect(result.effective_policy_decision).toBe("review");
    expect(result.automated_rating).toBe("adult_18");
    expect(result.fail_closed_reasons).toEqual(["unknown_category"]);
  });
});
