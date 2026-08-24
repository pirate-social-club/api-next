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
  description: null,
  policy,
};
const routeV1Draft = {
  ...draft,
  route_request: { family: "hns" as const, root_label: "jazleeuw" },
};
const requirements = {
  human_identity: {
    requirement: "human_identity" as const,
    status: "pending" as const,
    requirement_hash: "b".repeat(64),
    provider_id: "very.oauth",
    generation: 1,
    ceremony_intent_id: "human-ceremony-1",
    satisfied_at: null,
  },
  namespace_ownership: {
    requirement: "namespace_ownership" as const,
    status: "unmet" as const,
    requirement_hash: "c".repeat(64),
    provider_id: "hns.owner.v1",
    generation: 0,
    ceremony_intent_id: null,
    satisfied_at: null,
  },
};
const base = {
  intent_id: "intent-1",
  revision: 1,
  draft: routeV1Draft,
  canonical_policy_revision: 1,
  canonical_policy_hash: "a".repeat(64),
  requirements,
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
    ).toMatchObject({ draft: { name: "Jazleeuw", description: null } });
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

  test("requires route-free V2 creation and rejects namespace-derived fields", () => {
    const decode = Schema.decodeUnknownSync(CreateCommunityCreationIntent.request.body, {
      onExcessProperty: "error",
    });
    expect(decode({ idempotency_key: "create-route-free", draft })).toBeDefined();
    for (const route_request of [
      { family: "hns", root_label: "jazleeuw" },
      { family: "spaces", root_label: "music" },
    ]) {
      expect(() =>
        decode({
          idempotency_key: `reject-${route_request.root_label}`,
          draft: { ...draft, route_request },
        }),
      ).toThrow();
    }
    expect(() =>
      decode({ idempotency_key: "legacy-slug", draft: { ...draft, slug: "jazleeuw" } }),
    ).toThrow();
    expect(() =>
      decode({
        idempotency_key: "derived-route",
        draft: {
          ...draft,
          route_request: {
            family: "hns",
            root_label: "jazleeuw",
            href: "/c/app.evil",
          },
        },
      }),
    ).toThrow();
  });

  test("pins V2 to one human requirement and an immutable generated-id result", () => {
    const humanOnly = { human_identity: requirements.human_identity };
    const v2Base = {
      creation_contract_version: "optional_route_v2",
      intent_id: "intent-v2",
      revision: 1,
      draft,
      canonical_policy_revision: 1,
      canonical_policy_hash: "a".repeat(64),
      requirements: humanOnly,
      expires_at: "2026-08-20T13:00:00.000Z",
      committed_resource: null,
    };
    const decoded = Schema.decodeUnknownSync(CommunityCreationIntent)({
      ...v2Base,
      status: "verification_required",
      next_action: {
        kind: "start_verification",
        requirement: "human_identity",
        provider_id: "very.oauth",
        creation_intent_id: "intent-v2",
        ceremony_intent_id: "human-ceremony-1",
        generation: 1,
      },
    });
    expect(decoded.requirements).toEqual(humanOnly);

    const communityId = "community_123e4567-e89b-42d3-a456-426614174000";
    expect(
      Schema.decodeUnknownSync(CommunityCreationIntent)({
        ...v2Base,
        revision: 2,
        status: "committed",
        next_action: { kind: "none", reason: "committed" },
        committed_resource: {
          authority_version: "optional_route_v2",
          community_id: communityId,
          href: `/c/${communityId}`,
          canonical_route: null,
        },
      }).committed_resource,
    ).toMatchObject({ community_id: communityId, canonical_route: null });

    expect(() =>
      Schema.decodeUnknownSync(CommunityCreationIntent, { onExcessProperty: "error" })({
        ...v2Base,
        requirements,
        status: "verification_required",
        next_action: {
          kind: "start_verification",
          requirement: "human_identity",
          provider_id: "very.oauth",
          creation_intent_id: "intent-v2",
          ceremony_intent_id: "human-ceremony-1",
          generation: 1,
        },
      }),
    ).toThrow();
  });

  test("enforces the status, committed resource, and next-action invariants", () => {
    const decode = Schema.decodeUnknownSync(CommunityCreationIntent);
    expect(
      decode({
        ...base,
        status: "verification_required",
        next_action: {
          kind: "start_verification",
          requirement: "human_identity",
          provider_id: "very.oauth",
          creation_intent_id: "intent-1",
          ceremony_intent_id: "human-ceremony-1",
          generation: 1,
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
          href: "/c/app.jazleeuw",
          canonical_route: {
            family: "hns",
            root_label: "jazleeuw",
            root_label_display: "jazleeuw",
            path_segment: "app.jazleeuw",
            href: "/c/app.jazleeuw",
            app_host: null,
          },
        },
      }).committed_resource,
    ).toEqual({
      community_id: "community-jazleeuw",
      href: "/c/app.jazleeuw",
      canonical_route: {
        family: "hns",
        root_label: "jazleeuw",
        root_label_display: "jazleeuw",
        path_segment: "app.jazleeuw",
        href: "/c/app.jazleeuw",
        app_host: null,
      },
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
        next_action: { kind: "wait", requirement: null, reason_code: "free_form" },
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
        next_action: { kind: "wait", requirement: null, reason_code: "operation_pending" },
      }),
    ).toThrow();
  });

  test("pins both verification discriminators and pending wait requirements", () => {
    const decode = Schema.decodeUnknownSync(CommunityCreationIntent);
    const namespacePending = {
      ...requirements,
      human_identity: {
        ...requirements.human_identity,
        status: "satisfied" as const,
        satisfied_at: "2026-08-20T12:00:00.000Z",
      },
      namespace_ownership: {
        ...requirements.namespace_ownership,
        status: "pending" as const,
        generation: 1,
        ceremony_intent_id: "namespace-ceremony-1",
      },
    };
    expect(
      decode({
        ...base,
        requirements: namespacePending,
        status: "verification_required",
        next_action: {
          kind: "start_verification",
          requirement: "namespace_ownership",
          provider_id: "hns.owner.v1",
          creation_intent_id: "intent-1",
          ceremony_intent_id: "namespace-ceremony-1",
          generation: 1,
        },
      }).next_action,
    ).toMatchObject({ requirement: "namespace_ownership" });
    expect(
      decode({
        ...base,
        requirements: namespacePending,
        status: "verification_required",
        next_action: {
          kind: "wait",
          requirement: "namespace_ownership",
          reason_code: "verification_pending",
        },
      }).next_action,
    ).toMatchObject({ kind: "wait", requirement: "namespace_ownership" });
  });
});
