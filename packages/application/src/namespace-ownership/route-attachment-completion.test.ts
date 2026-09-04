import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type {
  NamespaceOwnershipProviderAdapter,
  NamespaceOwnershipProviderCompleteResult,
} from "./adapter.ts";
import { makeNamespaceOwnershipProviderRegistry } from "./registry.ts";
import {
  completeRouteAttachmentOwnership,
  type RouteAttachmentCompletionStore,
} from "./route-attachment-completion.ts";

const now = Date.parse("2026-09-04T10:00:00.000Z");
const input = {
  actor_id: "actor-1",
  community_id: "community-1",
  attachment_intent_id: "attachment-1",
  ceremony_intent_id: "ceremony-1",
  session_id: "namespace-1",
  expected_revision: 1,
  idempotency_key: "poll-1",
  channel: "poll_result" as const,
};
const stored = {
  namespace_session_id: "namespace-1",
  revision: 1,
  status: "pending" as const,
  terminal: null,
  session: {
    operation_kind: "route_attachment" as const,
    actor_id: input.actor_id,
    community_id: input.community_id,
    attachment_intent_id: input.attachment_intent_id,
    ceremony_intent_id: input.ceremony_intent_id,
    requirement_hash: "1".repeat(64),
    generation: 1,
    request_hash: "2".repeat(64),
    provider_id: "hns.owner.v1",
    provider_binding_hash: "3".repeat(64),
    provider_configuration: { kind: "managed" as const, reference: "owner", version: "1" },
    protocol_version: "hns-txt-v1",
    environment: "staging",
    route: {
      family: "hns" as const,
      root_label: "dankmemes",
      root_label_display: "dankmemes",
      path_segment: "app.dankmemes",
      href: "/c/app.dankmemes",
      app_host: null,
    },
    upstream_session_ref: "upstream-1",
    expires_at: "2026-09-04T11:00:00.000Z",
  },
};
const reservation = {
  completion_attempt_id: "completion-1",
  namespace_session_id: "namespace-1",
  fence_token: 1,
  evidence_ref: "evidence-1",
  lease_expires_at: "2026-09-04T10:00:16.000Z",
};

function provider(
  result: NamespaceOwnershipProviderCompleteResult,
): NamespaceOwnershipProviderAdapter {
  return {
    manifest: {
      provider_id: "hns.owner.v1",
      manifest_version: "1",
      supported_families: ["hns"],
      protocol_versions: ["hns-txt-v1"],
      environments: ["staging"],
      submission_channels: ["poll_result"],
      operation_deadlines: { plan_ms: 1_000, start_ms: 5_000, complete_ms: 15_000 },
    },
    plan: () => Effect.die("plan not expected"),
    start: () => Effect.die("creation start not expected"),
    complete: () => Effect.die("creation completion not expected"),
    startRouteAttachment: () => Effect.die("attachment start not expected"),
    completeRouteAttachment: () => Effect.succeed(result),
  };
}

function store(
  overrides: Partial<RouteAttachmentCompletionStore> = {},
): RouteAttachmentCompletionStore {
  return {
    load: () => Effect.succeed(stored),
    reserve: () => Effect.succeed({ kind: "acquired", reservation }),
    release: () => Effect.succeed("released"),
    finalize: (value) =>
      Effect.succeed({
        kind: "committed",
        status: value.status,
        result_hash: value.result_hash,
      }),
    ...overrides,
  };
}

async function services(
  result: Parameters<typeof provider>[0],
  completionStore: RouteAttachmentCompletionStore,
) {
  return {
    registry: await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([provider(result)], { now: () => now }),
    ),
    store: completionStore,
    ids: { attempt: () => "completion-1", evidence: () => "evidence-1" },
  };
}

describe("route attachment ownership completion", () => {
  test("releases a bounded attempt when the provider is still pending", async () => {
    let released = false;
    const result = await Effect.runPromise(
      completeRouteAttachmentOwnership(
        input,
        await services(
          { status: "pending" },
          store({
            release: () => Effect.sync(() => (released = true)).pipe(Effect.as("released")),
          }),
        ),
      ),
    );
    expect(result).toMatchObject({ status: "pending", retry_after_seconds: 1 });
    expect(released).toBe(true);
  });

  test("commits verified evidence without activating the community route", async () => {
    let finalized: Parameters<RouteAttachmentCompletionStore["finalize"]>[0] | undefined;
    const raw = new TextEncoder().encode('{"status":"verified"}');
    const result = await Effect.runPromise(
      completeRouteAttachmentOwnership(
        input,
        await services(
          {
            status: "verified",
            evidence_kind: "raw_provider_response_v1",
            provider_evidence_ref: "provider-evidence-1",
            raw_response_bytes: raw,
            observation: {},
            observed_at: "2026-09-04T09:59:00.000Z",
            expires_at: "2026-09-11T09:59:00.000Z",
          },
          store({
            finalize: (value) => {
              finalized = value;
              return Effect.succeed({
                kind: "committed",
                status: value.status,
                result_hash: value.result_hash,
              });
            },
          }),
        ),
      ),
    );
    expect(result).toMatchObject({ status: "verified", revision: 2, replayed: false });
    expect(finalized).toMatchObject({
      status: "verified",
      provider_response_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidence_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      provider_identity_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  test("returns a durable terminal replay before touching the provider", async () => {
    const terminal = {
      ...stored,
      revision: 2,
      status: "completed" as const,
      terminal: { status: "verified" as const, result_hash: "f".repeat(64) },
    };
    const result = await Effect.runPromise(
      completeRouteAttachmentOwnership(
        { ...input, expected_revision: 2 },
        {
          registry: {} as never,
          store: store({ load: () => Effect.succeed(terminal) }),
        },
      ),
    );
    expect(result).toMatchObject({ status: "verified", replayed: true });
  });
});
