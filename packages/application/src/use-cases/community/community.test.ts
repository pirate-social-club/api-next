import { describe, expect, test } from "bun:test";
import { GateUnsatisfied, MembershipRequired, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import type {
  CommunityPreviewDocument,
  CommunityStore,
  JoinEligibilityDocument,
  M2Actor,
} from "../../ports.ts";
import { followCommunity } from "./follow-community.ts";
import { getCommunityPreview } from "./get-community-preview.ts";
import { joinCommunity } from "./join-community.ts";
import type { CommunityServices } from "./services.ts";

const actor: M2Actor = { userId: "user-a", kind: "user" };

const preview = (communityId: string): CommunityPreviewDocument => ({
  id: communityId,
  object: "community_preview",
  display_name: communityId,
  membership_mode: "open",
  human_verification_lane: null,
  member_count: 1,
  follower_count: 0,
  moderators: [],
  membership_gate_summaries: [],
  rules: [],
  created: 0,
});

const eligibility = (
  communityId: string,
  status: JoinEligibilityDocument["status"] = "joinable",
): JoinEligibilityDocument => ({
  community: communityId,
  membership_mode: status === "gate_failed" ? "gated" : "open",
  human_verification_lane: null,
  joinable_now: status === "joinable",
  status,
  membership_gate_summaries: [],
  ...(status === "gate_failed" ? { failure_reason: "unsupported" as const } : {}),
});

function services(overrides: Partial<CommunityStore["Service"]> = {}): CommunityServices {
  return {
    communityStore: {
      membershipStatus: () => Effect.succeed("missing"),
      getPreview: ({ communityId }) => Effect.succeed(preview(communityId)),
      getJoinEligibility: ({ communityId }) => Effect.succeed(eligibility(communityId)),
      join: ({ communityId }) => Effect.succeed({ community: communityId, status: "joined" }),
      follow: ({ communityId }) =>
        Effect.succeed({ community: communityId, following: true, follower_count: 1 }),
      unfollow: ({ communityId }) =>
        Effect.succeed({ community: communityId, following: false, follower_count: 0 }),
      ...overrides,
    },
  };
}

describe("community application use cases", () => {
  test("keeps preview lookups community-scoped and turns absence into NotFound", async () => {
    const scoped = services({
      getPreview: ({ communityId }) =>
        Effect.succeed(communityId === "community-a" ? preview(communityId) : null),
    });

    await expect(
      Effect.runPromise(
        getCommunityPreview({ communityId: "community-a", viewerUserId: actor.userId }, scoped),
      ),
    ).resolves.toMatchObject({ id: "community-a" });
    await expect(
      Effect.runPromise(
        getCommunityPreview({ communityId: "community-b", viewerUserId: actor.userId }, scoped),
      ),
    ).rejects.toBeInstanceOf(NotFound);
  });

  test("fails closed for a gated community before attempting a join", async () => {
    let joinCalls = 0;
    const scoped = services({
      getJoinEligibility: () => Effect.succeed(eligibility("community-a", "gate_failed")),
      join: () => {
        joinCalls += 1;
        return Effect.succeed({ community: "community-a", status: "joined" as const });
      },
    });

    await expect(
      Effect.runPromise(joinCommunity({ communityId: "community-a", actor }, scoped)),
    ).rejects.toBeInstanceOf(GateUnsatisfied);
    expect(joinCalls).toBe(0);
  });

  test("requires membership for follow, even when another community has membership", async () => {
    const scoped = services({
      getPreview: ({ communityId }) => Effect.succeed(preview(communityId)),
      membershipStatus: ({ communityId }) =>
        Effect.succeed(communityId === "community-a" ? ("missing" as const) : ("member" as const)),
    });

    await expect(
      Effect.runPromise(followCommunity({ communityId: "community-a", actor }, scoped)),
    ).rejects.toBeInstanceOf(MembershipRequired);
  });
});
