import { describe, expect, test } from "bun:test";
import { decodeCreationRequirementProgressV1 } from "@pirate/contracts";
import type { CreationRequirementProgress } from "@pirate/domain";
import {
  publicCommunityCreationRequirements,
  publicCreationRequirementProgress,
  publicOptionalRouteCommunityCreationRequirements,
} from "./creation-requirement-projection.ts";

const human: CreationRequirementProgress = {
  requirement: "human_identity",
  status: "satisfied",
  requirement_hash: "a".repeat(64),
  provider_id: "very.oauth",
  provider_binding_hash: "b".repeat(64),
  generation: 1,
  ceremony_intent_id: "ceremony-human-1",
  satisfied_at: "2026-08-20T12:00:00.000Z",
};

const namespace: CreationRequirementProgress = {
  requirement: "namespace_ownership",
  status: "pending",
  requirement_hash: "c".repeat(64),
  provider_id: "hns.owner.v1",
  provider_binding_hash: "d".repeat(64),
  generation: 2,
  ceremony_intent_id: "ceremony-namespace-2",
  satisfied_at: null,
};

describe("community creation requirement public projection", () => {
  test("constructs the closed public shape without authority fingerprints", () => {
    const projected = publicCreationRequirementProgress(human);

    expect(projected).toEqual({
      requirement: "human_identity",
      status: "satisfied",
      requirement_hash: "a".repeat(64),
      provider_id: "very.oauth",
      generation: 1,
      ceremony_intent_id: "ceremony-human-1",
      satisfied_at: "2026-08-20T12:00:00.000Z",
    });
    expect("provider_binding_hash" in projected).toBe(false);
    expect(() => decodeCreationRequirementProgressV1({ ...human })).toThrow();
  });

  test("projects a requirement-free optional-route intent as an empty map", () => {
    expect(publicOptionalRouteCommunityCreationRequirements(null)).toEqual({});
  });

  test("pins both keyed requirements and rejects a swapped projection", () => {
    expect(
      publicCommunityCreationRequirements({
        human_identity: human,
        namespace_ownership: namespace,
      }),
    ).toMatchObject({
      human_identity: { requirement: "human_identity", provider_id: "very.oauth" },
      namespace_ownership: {
        requirement: "namespace_ownership",
        provider_id: "hns.owner.v1",
      },
    });

    expect(() =>
      publicCommunityCreationRequirements({
        human_identity: namespace,
        namespace_ownership: human,
      }),
    ).toThrow();
  });

  test("fails closed on malformed internal authority even when the field is private", () => {
    expect(() =>
      publicCreationRequirementProgress({ ...human, provider_binding_hash: "malformed" }),
    ).toThrow();
  });
});
