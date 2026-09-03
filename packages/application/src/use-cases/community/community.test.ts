import { describe, expect, test } from "bun:test";
import { BadRequest, Conflict, GateUnsatisfied, InternalError, NotFound } from "@pirate/contracts";
import { Effect } from "effect";
import {
  type CommunityPreviewDocument,
  CommunityRepositoryError,
  type CommunityStore,
  ControlPlaneStatementFailed,
  type JoinEligibilityDocument,
  type M2Actor,
} from "../../ports.ts";
import { followCommunity } from "./follow-community.ts";
import { getCommunityPreview } from "./get-community-preview.ts";
import { joinCommunity } from "./join-community.ts";
import type { CommunityServices } from "./services.ts";
import { unfollowCommunity } from "./unfollow-community.ts";

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
  membershipMode: JoinEligibilityDocument["membership_mode"] = "open",
): JoinEligibilityDocument => {
  const next_action: JoinEligibilityDocument["next_action"] =
    status === "already_joined"
      ? { kind: "none", reason: "already_joined" }
      : status === "banned"
        ? { kind: "blocked", reason: "banned" }
        : status === "gate_failed"
          ? { kind: "blocked", reason: "gate_failed" }
          : status === "pending_request"
            ? { kind: "wait", reason_code: "membership_pending" }
            : status === "requestable"
              ? { kind: "request_membership" }
              : status === "verification_required"
                ? {
                    kind: "start_verification",
                    provider_id: "very.oauth",
                    intent_id: "join-intent-1",
                  }
                : { kind: "join" };
  return {
    community: communityId,
    membership_mode:
      membershipMode === "request"
        ? "request"
        : status === "gate_failed" || status === "verification_required"
          ? "gated"
          : "open",
    human_verification_lane: null,
    joinable_now: status === "joinable",
    status,
    membership_gate_summaries: [],
    ...(status === "gate_failed" ? { failure_reason: "unsupported" as const } : {}),
    next_action,
  };
};

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

  test("requires a persona choice at a terminal join and forbids one on a request-mode join", async () => {
    let joinCalls = 0;
    const scoped = services({
      join: () => {
        joinCalls += 1;
        return Effect.succeed({ community: "community-a", status: "joined" as const });
      },
    });

    await expect(
      Effect.runPromise(joinCommunity({ communityId: "community-a", actor }, scoped)),
    ).rejects.toBeInstanceOf(BadRequest);
    await expect(
      Effect.runPromise(
        joinCommunity(
          {
            communityId: "community-a",
            actor,
            body: { persona: { kind: "existing", persona_id: "persona-a" } },
          },
          scoped,
        ),
      ),
    ).resolves.toMatchObject({ community: "community-a", status: "joined" });
    expect(joinCalls).toBe(1);

    const requestMode = services({
      getJoinEligibility: () =>
        Effect.succeed(eligibility("community-a", "requestable", "request")),
      join: () => {
        joinCalls += 1;
        return Effect.succeed({ community: "community-a", status: "requested" as const });
      },
    });
    await expect(
      Effect.runPromise(
        joinCommunity(
          {
            communityId: "community-a",
            actor,
            body: { persona: { kind: "create_new" } },
          },
          requestMode,
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequest);
    await expect(
      Effect.runPromise(
        joinCommunity({ communityId: "community-a", actor, body: {} }, requestMode),
      ),
    ).resolves.toMatchObject({ community: "community-a", status: "requested" });
  });

  test("keeps an already-member join idempotent without a persona choice", async () => {
    const scoped = services({
      getJoinEligibility: () => Effect.succeed(eligibility("community-a", "already_joined")),
    });

    await expect(
      Effect.runPromise(joinCommunity({ communityId: "community-a", actor }, scoped)),
    ).resolves.toMatchObject({ community: "community-a", status: "joined" });
  });

  test("allows a nonmember to follow a live community", async () => {
    const scoped = services({
      getPreview: ({ communityId }) => Effect.succeed(preview(communityId)),
    });

    await expect(
      Effect.runPromise(followCommunity({ communityId: "community-a", actor }, scoped)),
    ).resolves.toMatchObject({ community: "community-a", following: true });
  });

  test("redacts storage failures instead of converting them to a 4xx", async () => {
    const storageFailure = new ControlPlaneStatementFailed({
      label: "community.communities.get-preview",
      sqlState: "XX000",
      constraint: null,
      outcomeCertainty: "completed",
    });
    const scoped = services({
      getPreview: () => Effect.fail(storageFailure),
    });

    await expect(
      Effect.runPromise(getCommunityPreview({ communityId: "community-a" }, scoped)),
    ).rejects.toBeInstanceOf(InternalError);
  });

  test("maps the repository's active-member unfollow conflict", async () => {
    const scoped = services({
      unfollow: () =>
        Effect.fail(new CommunityRepositoryError({ operation: "unfollow", reason: "constraint" })),
    });

    await expect(
      Effect.runPromise(unfollowCommunity({ communityId: "community-a", actor }, scoped)),
    ).rejects.toBeInstanceOf(Conflict);
  });
});
