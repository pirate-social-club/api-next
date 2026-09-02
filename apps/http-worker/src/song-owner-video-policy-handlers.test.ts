import { describe, expect, test } from "bun:test";
import type { SongOwnerPolicyStoreService } from "@pirate/application/use-cases/song-owner-video-policy";
import { Effect } from "effect";
import { makeSongOwnerVideoPolicyHandlers } from "./song-owner-video-policy-handlers.ts";
import { createHttpWorker, type DecodedRequest } from "./transport.ts";

const management = {
  object: "song_owner_policy" as const,
  community_id: "community-1",
  post_id: "song-1",
  audio_revision: 1,
  owner_account_id: "account-owner",
  policy_revision: 2,
  third_party_reward_legs: "allowed" as const,
  pool_leg: "declined" as const,
  derivative_video: "owner_only" as const,
  policy_hash: "11".repeat(32),
  effective_at: "2026-09-02T12:00:00.000Z",
};

const publicPolicy = {
  object: "song_owner_policy" as const,
  community_id: "community-1",
  post_id: "song-1",
  audio_revision: 1,
  policy_revision: 2,
  third_party_reward_legs: "allowed" as const,
  pool_leg: "declined" as const,
  derivative_video: "owner_only" as const,
  can_post_with_song: false,
};

const request = (overrides: Partial<DecodedRequest> = {}): DecodedRequest =>
  ({
    params: { communityId: "community-1", postId: "song-1" },
    query: {},
    body: undefined,
    principal: null,
    ...overrides,
  }) as DecodedRequest;

describe("song owner video policy handlers", () => {
  test("passes owner account and persona to management operations and hides it publicly", async () => {
    const observed: Array<Record<string, unknown>> = [];
    const store: SongOwnerPolicyStoreService = {
      getManagement: (input) => {
        observed.push({ operation: "get-management", ...input });
        return Effect.succeed(management);
      },
      update: (input) => {
        observed.push({ operation: "update", ...input });
        return Effect.succeed(management);
      },
      getPublic: (input) => {
        observed.push({ operation: "get-public", ...input });
        return Effect.succeed(publicPolicy);
      },
    };
    const handlers = makeSongOwnerVideoPolicyHandlers({ store });
    const principal = { kind: "user" as const, subject: "account-owner" };

    await expect(
      handlers.GetSongOwnerPolicy(request({ principal, query: { persona_id: "persona-owner" } })),
    ).resolves.toEqual(management);
    await expect(
      handlers.UpdateSongOwnerPolicy(
        request({
          principal,
          body: {
            persona_id: "persona-owner",
            expected_policy_revision: 2,
            third_party_reward_legs: "allowed",
            pool_leg: "declined",
            derivative_video: "blocked",
          },
        }),
      ),
    ).resolves.toEqual(management);
    await expect(
      handlers.GetPublicSongOwnerPolicy(
        request({ principal: null, query: { persona_id: "persona-owner" } }),
      ),
    ).resolves.toEqual(publicPolicy);
    expect(observed).toEqual([
      {
        operation: "get-management",
        communityId: "community-1",
        postId: "song-1",
        accountId: "account-owner",
        personaId: "persona-owner",
      },
      {
        operation: "update",
        communityId: "community-1",
        postId: "song-1",
        accountId: "account-owner",
        update: {
          persona_id: "persona-owner",
          expected_policy_revision: 2,
          third_party_reward_legs: "allowed",
          pool_leg: "declined",
          derivative_video: "blocked",
        },
      },
      {
        operation: "get-public",
        communityId: "community-1",
        postId: "song-1",
        accountId: null,
        personaId: "persona-owner",
      },
    ]);
  });

  test("rejects admin authority for private owner management", async () => {
    const store: SongOwnerPolicyStoreService = {
      getManagement: () => Effect.succeed(management),
      update: () => Effect.succeed(management),
      getPublic: () => Effect.succeed(publicPolicy),
    };
    const handlers = makeSongOwnerVideoPolicyHandlers({ store });
    expect(() =>
      handlers.GetSongOwnerPolicy(
        request({
          principal: { kind: "admin", subject: "admin-1" },
          query: { persona_id: "persona-owner" },
        }),
      ),
    ).toThrow();
  });

  test("serves the registered public projection without an owner identity", async () => {
    const store: SongOwnerPolicyStoreService = {
      getManagement: () => Effect.succeed(management),
      update: () => Effect.succeed(management),
      getPublic: () => Effect.succeed(publicPolicy),
    };
    const worker = createHttpWorker({
      handlers: makeSongOwnerVideoPolicyHandlers({ store }),
      authenticate: () => ({ kind: "user", subject: "account-owner" }),
      authorize: () => undefined,
    });
    const response = await worker.request(
      "http://worker.test/communities/community-1/posts/song-1/owner-policy/public",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toEqual(publicPolicy);
    expect(body).not.toHaveProperty("owner_account_id");

    const managementResponse = await worker.request(
      "http://worker.test/communities/community-1/posts/song-1/owner-policy?persona_id=persona-owner",
      { headers: { authorization: "Bearer session" } },
    );
    expect(managementResponse.status).toBe(200);
    expect(managementResponse.headers.get("cache-control")).toBe("private, no-store");
  });
});
