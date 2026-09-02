import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  GetPublicSongOwnerPolicy,
  GetSongOwnerPolicy,
  PublicSongOwnerPolicyV1,
  SongOwnerPolicyManagementV1,
  UpdateSongOwnerPolicy,
} from "./song-owner-video-policy.ts";

const strictDecode = (schema: Schema.Schema<unknown>) =>
  Schema.decodeUnknownSync(schema as unknown as Schema.ConstraintDecoder<unknown>, {
    onExcessProperty: "error",
  });

const management = {
  object: "song_owner_policy",
  community_id: "community-1",
  post_id: "song-1",
  audio_revision: 1,
  owner_account_id: "account-owner",
  policy_revision: 2,
  third_party_reward_legs: "allowed",
  pool_leg: "declined",
  derivative_video: "owner_only",
  policy_hash: "11".repeat(32),
  effective_at: "2026-09-02T12:00:00.000Z",
} as const;

describe("song owner derivative-video policy contracts", () => {
  test("keeps the owner identity in management responses only", () => {
    expect(strictDecode(SongOwnerPolicyManagementV1)(management)).toEqual(management);
    const publicPolicy = {
      object: "song_owner_policy",
      community_id: management.community_id,
      post_id: management.post_id,
      audio_revision: management.audio_revision,
      policy_revision: management.policy_revision,
      third_party_reward_legs: management.third_party_reward_legs,
      pool_leg: management.pool_leg,
      derivative_video: management.derivative_video,
      can_post_with_song: false,
    } as const;
    expect(strictDecode(PublicSongOwnerPolicyV1)(publicPolicy)).toMatchObject({
      object: "song_owner_policy",
      derivative_video: "owner_only",
      can_post_with_song: false,
    });
    expect(() => strictDecode(PublicSongOwnerPolicyV1)(management)).toThrow();
  });

  test("requires an explicit persona for private reads and updates", () => {
    expect(GetSongOwnerPolicy.request?.query).toBeDefined();
    expect(UpdateSongOwnerPolicy.request?.body).toBeDefined();
    expect(GetSongOwnerPolicy.auth).toEqual({ policy: { kind: "user" } });
    expect(GetPublicSongOwnerPolicy.auth).toEqual({
      policy: { kind: "user" },
      optionalUser: true,
    });
  });
});
