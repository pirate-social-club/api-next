import { describe, expect, test } from "bun:test";
import {
  CommunityRepositoryError,
  ControlPlaneDb,
  type ControlPlaneResult,
  type ControlPlaneStatement,
} from "@pirate/application";
import { Effect } from "effect";

import { makeControlPlaneCommunityRepository } from "./community-repository.ts";

type CommunityState = {
  readonly ids: ReadonlySet<string>;
  readonly names: ReadonlyMap<string, string>;
  readonly memberships: readonly {
    readonly communityId: string;
    readonly userId: string;
    readonly status: "pending" | "member" | "left" | "banned";
  }[];
  readonly follows: readonly { readonly communityId: string; readonly userId: string }[];
};

function fakeDb(state: CommunityState): ControlPlaneDb["Service"] {
  const execute = <Row = unknown>(
    statement: ControlPlaneStatement,
  ): Effect.Effect<ControlPlaneResult<Row>, never> => {
    const [communityId, userId] = statement.values as readonly [string?, string?];
    const membership = state.memberships.find(
      (candidate) =>
        candidate.communityId === (communityId ?? "") && candidate.userId === (userId ?? ""),
    )?.status;
    const follow = state.follows.some(
      (candidate) =>
        candidate.communityId === (communityId ?? "") && candidate.userId === (userId ?? ""),
    );
    let rows: readonly Record<string, unknown>[] = [];

    switch (statement.label) {
      case "community.memberships.status":
        rows = membership === undefined ? [] : [{ status: membership }];
        break;
      case "community.communities.get-preview":
        if (state.ids.has(communityId ?? "")) {
          const memberCount = state.memberships.filter(
            (candidate) => candidate.communityId === communityId && candidate.status === "member",
          ).length;
          const followerCount = state.follows.filter(
            (candidate) => candidate.communityId === communityId,
          ).length;
          rows = [
            {
              community_id: communityId,
              display_name: state.names.get(communityId ?? "") ?? communityId,
              membership_mode: "open",
              human_verification_lane: null,
              created_at: "2026-01-01T00:00:00.000Z",
              member_count: String(memberCount),
              follower_count: String(followerCount),
              viewer_membership_status: membership ?? "missing",
              viewer_following: follow,
            },
          ];
        }
        break;
      case "community.memberships.get-eligibility":
        if (state.ids.has(communityId ?? "")) {
          rows = [
            {
              community_id: communityId,
              membership_mode: "open",
              human_verification_lane: null,
              created_at: "2026-01-01T00:00:00.000Z",
              status: membership ?? "missing",
            },
          ];
        }
        break;
      case "community.memberships.join-community":
      case "community.follows.lock-community":
      case "community.follows.lock-community-unfollow":
        rows = state.ids.has(communityId ?? "") ? [{ community_id: communityId }] : [];
        break;
      case "community.memberships.lock-member":
      case "community.follows.require-member":
        rows = membership === undefined ? [] : [{ status: membership }];
        break;
      case "community.follows.count":
      case "community.follows.count-after-unfollow":
        rows = [
          {
            follower_count: state.follows.filter(
              (candidate) => candidate.communityId === communityId,
            ).length,
          },
        ];
        break;
      case "community.memberships.insert":
      case "community.memberships.reactivate":
      case "community.follows.activate":
      case "community.follows.deactivate":
        rows = [];
        break;
      default:
        throw new Error(`Unexpected statement ${statement.label}`);
    }
    return Effect.succeed({ rows: rows as readonly Row[], rowCount: rows.length });
  };

  return {
    execute,
    withTransaction: <A, E, R>(
      use: (transaction: { readonly execute: typeof execute }) => Effect.Effect<A, E, R>,
    ) => use({ execute }),
  } satisfies ControlPlaneDb["Service"];
}

const run = <A, E>(effect: Effect.Effect<A, E, ControlPlaneDb>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(
        ControlPlaneDb,
        fakeDb({
          ids: new Set(["community-a", "community-b"]),
          names: new Map([
            ["community-a", "A"],
            ["community-b", "B"],
          ]),
          memberships: [{ communityId: "community-b", userId: "user-a", status: "member" }],
          follows: [],
        }),
      ),
    ),
  );

describe("community Postgres repository boundary", () => {
  test("does not let membership in community B authorize a follow in community A", async () => {
    const repository = makeControlPlaneCommunityRepository();
    await expect(
      run(
        repository.follow({
          communityId: "community-a",
          actor: { userId: "user-a", kind: "user" },
        }),
      ),
    ).rejects.toBeInstanceOf(CommunityRepositoryError);

    await expect(
      run(repository.getPreview({ communityId: "community-a", viewerUserId: "user-a" })),
    ).resolves.toMatchObject({
      id: "community-a",
      viewer_membership_status: "not_member",
      member_count: 0,
      follower_count: 0,
    });
  });

  test("returns missing rather than leaking rows from another community", async () => {
    const repository = makeControlPlaneCommunityRepository();
    await expect(
      run(repository.membershipStatus({ communityId: "community-a", userId: "user-a" })),
    ).resolves.toBe("missing");
    await expect(
      run(repository.getJoinEligibility({ communityId: "community-a", userId: "user-a" })),
    ).resolves.toMatchObject({ community: "community-a", status: "joinable" });
  });
});
