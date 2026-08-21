import { describe, expect, test } from "bun:test";
import {
  communityJoinActionPayloadHash,
  communityJoinActionPayloadPreimage,
  communityJoinIntentBindingHash,
  communityJoinIntentBindingPreimage,
} from "./join-intent-binding.ts";

describe("community join intent hashes", () => {
  test("pins a canonical action payload independent of the actor", () => {
    expect(communityJoinActionPayloadPreimage("community-a")).toBe(
      '{"action_kind":"community_join","community_id":"community-a","version":1}',
    );
    expect(communityJoinActionPayloadHash("community-a")).toMatch(/^[0-9a-f]{64}$/u);
  });

  test("binds actor, community, policy, requirement, and provider configuration", () => {
    const input = { actorId: "user-a", communityId: "community-a" };
    const preimage = communityJoinIntentBindingPreimage(input);
    expect(preimage).toContain('"actor_id":"user-a"');
    expect(preimage).toContain('"provider_id":"very.web"');
    expect(preimage).toContain('"policy_version_id":"curated-human-membership-v1"');
    expect(communityJoinIntentBindingHash(input)).toMatch(/^[0-9a-f]{64}$/u);
    expect(communityJoinIntentBindingHash({ ...input, actorId: "user-b" })).not.toBe(
      communityJoinIntentBindingHash(input),
    );
    expect(communityJoinIntentBindingHash({ ...input, communityId: "community-b" })).not.toBe(
      communityJoinIntentBindingHash(input),
    );
  });
});
