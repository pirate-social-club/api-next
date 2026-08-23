import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CommunityCreationRequirementsV1,
  CommunityCreationRequirementsV2,
  decodeCommunityCreationRequirementsV1,
  decodeCommunityCreationRequirementsV2,
  decodeCreationRequirementProgressV1,
} from "./community-creation-requirements.ts";

const human = {
  requirement: "human_identity" as const,
  status: "satisfied" as const,
  requirement_hash: "a".repeat(64),
  provider_id: "very.oauth",
  generation: 1,
  ceremony_intent_id: "ceremony-human-1",
  satisfied_at: "2026-08-20T13:00:00.000Z",
};

const namespace = {
  requirement: "namespace_ownership" as const,
  status: "unmet" as const,
  requirement_hash: "b".repeat(64),
  provider_id: "hns.owner.v1",
  generation: 0,
  ceremony_intent_id: null,
  satisfied_at: null,
};

describe("community creation requirement contracts", () => {
  test("round-trips the complete keyed public progress projection", () => {
    const decoded = decodeCommunityCreationRequirementsV1({
      human_identity: human,
      namespace_ownership: namespace,
    });
    expect(decoded).toEqual({ human_identity: human, namespace_ownership: namespace });
    expect(Schema.encodeSync(CommunityCreationRequirementsV1)(decoded)).toEqual(decoded);
  });

  test("freezes V2 to exactly one human identity requirement", () => {
    const decoded = decodeCommunityCreationRequirementsV2({ human_identity: human });
    expect(Schema.encodeSync(CommunityCreationRequirementsV2)(decoded)).toEqual({
      human_identity: human,
    });
    expect(() =>
      decodeCommunityCreationRequirementsV2({
        human_identity: human,
        namespace_ownership: namespace,
      }),
    ).toThrow();
  });

  test("enforces the closed progress-state cross-field invariant", () => {
    for (const invalid of [
      { ...namespace, status: "unknown" },
      { ...namespace, requirement_hash: "not-a-hash" },
      { ...namespace, provider_id: " very.oauth" },
      { ...namespace, generation: -1 },
      { ...namespace, generation: 0.5 },
      { ...namespace, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...namespace, status: "pending", ceremony_intent_id: null },
      { ...namespace, ceremony_intent_id: "ceremony-forged" },
      { ...human, satisfied_at: null },
      { ...human, satisfied_at: "2026-08-20T13:00:00Z" },
      { ...human, status: "failed" },
    ]) {
      expect(() => decodeCreationRequirementProgressV1(invalid)).toThrow();
    }
  });

  test("rejects mismatched keys, private authority fields, and excess wire properties", () => {
    expect(() => decodeCommunityCreationRequirementsV1({ human_identity: human })).toThrow();
    expect(() =>
      decodeCommunityCreationRequirementsV1({
        human_identity: { ...namespace, requirement: "namespace_ownership" },
        namespace_ownership: namespace,
      }),
    ).toThrow();
    expect(() =>
      decodeCreationRequirementProgressV1({
        ...human,
        provider_binding_hash: "c".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      decodeCommunityCreationRequirementsV1({
        human_identity: { ...human, provider_binding_hash: "c".repeat(64) },
        namespace_ownership: namespace,
      }),
    ).toThrow();
    expect(() =>
      decodeCommunityCreationRequirementsV1({
        human_identity: human,
        namespace_ownership: namespace,
        extra_requirement: namespace,
      }),
    ).toThrow();
  });
});
