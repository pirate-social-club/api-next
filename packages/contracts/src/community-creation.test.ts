import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  CommitCommunityCreationIntent,
  CommunityCreationIntent,
  CompiledGatePolicy,
  CreateCommunityCreationIntent,
  GetCommunityCreationIntent,
  UpdateCommunityCreationIntent,
} from "./community-creation.ts";

const policy = {
  version: 1 as const,
  accessPaths: [
    {
      id: "path-1",
      operator: "and" as const,
      requirements: [{ requirement: "human-verification" as const }],
    },
  ] as const,
};
const draft = {
  name: "Jazleeuw",
  slug: "jazleeuw",
  description: null,
  policy,
};
const base = {
  intent_id: "intent-1",
  revision: 1,
  draft,
  canonical_policy_revision: 1,
  canonical_policy_hash: "a".repeat(64),
  verification_requirement_hash: "b".repeat(64),
  expires_at: "2026-08-20T13:00:00.000Z",
  committed_resource: null,
};

describe("community creation contracts", () => {
  test("accepts the provider-neutral compiled human policy", () => {
    expect(Schema.decodeUnknownSync(CompiledGatePolicy)(policy)).toEqual(policy);
    expect(() =>
      Schema.decodeUnknownSync(CompiledGatePolicy)({
        ...policy,
        accessPaths: [
          {
            id: "path-1",
            operator: "or",
            requirements: [{ requirement: "very.oauth" }],
          },
        ],
      }),
    ).toThrow();
  });

  test("freezes resumable create, read, update, and commit endpoint shapes", () => {
    expect(CreateCommunityCreationIntent.method).toBe("POST");
    expect(CreateCommunityCreationIntent.path).toBe("/community-creation-intents");
    expect(CreateCommunityCreationIntent.successStatus).toEqual([200, 201]);
    expect(GetCommunityCreationIntent.path).toBe("/community-creation-intents/:intentId");
    expect(UpdateCommunityCreationIntent.method).toBe("PATCH");
    expect(CommitCommunityCreationIntent.successStatus).toEqual([200, 201]);

    expect(
      Schema.decodeUnknownSync(CreateCommunityCreationIntent.request.body)({
        idempotency_key: "create-key-1",
        draft,
      }),
    ).toMatchObject({ draft: { slug: "jazleeuw" } });
    expect(
      Schema.decodeUnknownSync(UpdateCommunityCreationIntent.request.body)({
        idempotency_key: "update-key-1",
        expected_revision: 1,
        draft,
      }).expected_revision,
    ).toBe(1);
    expect(
      Schema.decodeUnknownSync(CommitCommunityCreationIntent.request.body)({
        idempotency_key: "commit-key-1",
        expected_revision: 2,
      }),
    ).toEqual({ idempotency_key: "commit-key-1", expected_revision: 2 });
  });

  test("accepts local route slugs and rejects hostnames or malformed segments", () => {
    const decode = Schema.decodeUnknownSync(CreateCommunityCreationIntent.request.body);
    for (const slug of ["jazleeuw", "techno-hippies", "a".repeat(256)]) {
      expect(
        decode({ idempotency_key: `create-${slug.length}`, draft: { ...draft, slug } }),
      ).toBeDefined();
    }
    for (const slug of [
      "app.jazleeuw",
      "Jazleeuw",
      "techno_hippies",
      "-jazleeuw",
      "a".repeat(257),
    ]) {
      expect(() =>
        decode({ idempotency_key: `reject-${slug.length}`, draft: { ...draft, slug } }),
      ).toThrow();
    }
  });

  test("enforces the status, committed resource, and next-action invariants", () => {
    const decode = Schema.decodeUnknownSync(CommunityCreationIntent);
    expect(
      decode({
        ...base,
        status: "verification_required",
        next_action: {
          kind: "start_verification",
          provider_id: "very.oauth",
          intent_id: "intent-1",
        },
      }).status,
    ).toBe("verification_required");
    expect(
      decode({
        ...base,
        revision: 4,
        status: "committed",
        next_action: { kind: "none", reason: "committed" },
        committed_resource: {
          community_id: "community-jazleeuw",
          href: "/communities/community-jazleeuw",
        },
      }).committed_resource,
    ).toEqual({
      community_id: "community-jazleeuw",
      href: "/communities/community-jazleeuw",
    });
    for (const invalid of [
      { ...base, status: "committed", next_action: { kind: "none", reason: "committed" } },
      {
        ...base,
        status: "quota_exceeded",
        next_action: { kind: "blocked", reason: "gate_unsupported" },
      },
      {
        ...base,
        status: "verification_required",
        next_action: { kind: "commit" },
      },
      {
        ...base,
        status: "draft",
        next_action: { kind: "wait", reason_code: "free_form" },
      },
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
  });

  test("rejects stale-shape primitives before application code", () => {
    expect(() =>
      Schema.decodeUnknownSync(UpdateCommunityCreationIntent.request.body)({
        idempotency_key: "update-key-1",
        expected_revision: 0,
        draft,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CommunityCreationIntent)({
        ...base,
        status: "draft",
        canonical_policy_hash: "not-a-hash",
        next_action: { kind: "wait", reason_code: "operation_pending" },
      }),
    ).toThrow();
  });
});
