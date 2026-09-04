import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type {
  NamespaceOwnershipProviderAdapter,
  RouteAttachmentOwnershipProviderStartInput,
  RouteAttachmentOwnershipProviderStartResult,
} from "./adapter.ts";
import { hnsRouteAttachmentStartHash } from "./hns-evidence.ts";
import { makeNamespaceOwnershipProviderRegistry } from "./registry.ts";
import {
  type RouteAttachmentOwnershipStartAuthority,
  RouteAttachmentOwnershipStartRejected,
  type RouteAttachmentOwnershipStartServices,
  type RouteAttachmentOwnershipStartStore,
  startRouteAttachmentOwnership,
} from "./route-attachment-start.ts";

const now = Date.parse("2026-09-02T12:00:00.000Z");
const providerConfiguration = {
  kind: "managed" as const,
  reference: "hns-owner-staging",
  version: "hns-owner-config-v1",
};
const route = {
  family: "hns" as const,
  root_label: "xn--pokmon-dva",
  root_label_display: "pokémon",
  path_segment: "app.xn--pokmon-dva",
  href: "/c/app.xn--pokmon-dva",
  app_host: null,
};
const authority: RouteAttachmentOwnershipStartAuthority = {
  actor_id: "user-1",
  community_id: "community-1",
  attachment_intent_id: "attachment-1",
  ceremony_intent_id: "attachment-ceremony-1",
  expected_revision: 1,
  requirement_hash: "1".repeat(64),
  generation: 1,
  provider_id: "hns.owner.v1",
  provider_binding_hash: "2".repeat(64),
  provider_configuration: providerConfiguration,
  route,
};
const input = {
  actor_id: authority.actor_id,
  community_id: authority.community_id,
  attachment_intent_id: authority.attachment_intent_id,
  ceremony_intent_id: authority.ceremony_intent_id,
  expected_revision: 1,
  idempotency_key: "start-1",
};
const reservation = {
  reservation_id: "reservation-1",
  namespace_session_id: "attachment-namespace-session-1",
  expected_revision: 1,
  fence_token: 1,
  lease_expires_at: "2026-09-02T12:00:07.000Z",
};

function started(
  providerInput: RouteAttachmentOwnershipProviderStartInput,
): RouteAttachmentOwnershipProviderStartResult {
  return {
    session: {
      ...providerInput,
      provider_id: "hns.owner.v1",
      upstream_session_ref: "nvs_attachment_1",
      expires_at: "2026-09-02T13:00:00.000Z",
    },
    presentation: {
      kind: "embedded_sdk",
      session_id: "nvs_attachment_1",
      protocol: "hns-txt-challenge",
      version: "1",
      payload: {
        ownership_source: "owner_authoritative_dns_txt",
        challenge_name: "_pirate.xn--pokmon-dva",
        challenge_value: "pirate-verification=nvs_attachment_1",
        expires_at: "2026-09-02T13:00:00.000Z",
      },
    },
  };
}

function adapter(
  onStart?: (input: RouteAttachmentOwnershipProviderStartInput) => void,
  attachmentCapable = true,
): NamespaceOwnershipProviderAdapter {
  const base: NamespaceOwnershipProviderAdapter = {
    manifest: {
      provider_id: "hns.owner.v1",
      manifest_version: "1",
      supported_families: ["hns"],
      protocol_versions: ["hns-txt-v1"],
      environments: ["staging"],
      submission_channels: ["poll_result"],
      operation_deadlines: { plan_ms: 1_000, start_ms: 5_000, complete_ms: 15_000 },
    },
    plan: () =>
      Effect.succeed({
        status: "supported",
        provider_configuration: providerConfiguration,
        protocol_version: "hns-txt-v1",
      }),
    start: () => Effect.die("creation start is outside this test"),
    complete: () => Effect.die("creation completion is outside this test"),
  };
  if (!attachmentCapable) return base;
  return {
    ...base,
    startRouteAttachment: (providerInput) => {
      onStart?.(providerInput);
      return Effect.succeed(started(providerInput));
    },
    completeRouteAttachment: () => Effect.succeed({ status: "pending" }),
  };
}

function store(
  overrides: Partial<RouteAttachmentOwnershipStartStore> = {},
): RouteAttachmentOwnershipStartStore {
  return {
    replay: () => Effect.succeed({ kind: "none" }),
    reserve: () => Effect.succeed({ kind: "acquired", reservation }),
    finalize: (_reservation, providerStart) =>
      Effect.succeed({
        kind: "created",
        namespace_session_id: reservation.namespace_session_id,
        start: providerStart,
      }),
    release: () => Effect.void,
    ...overrides,
  };
}

async function services(
  options: Readonly<{
    store?: RouteAttachmentOwnershipStartStore;
    resolve?: RouteAttachmentOwnershipStartServices["intents"]["resolve"];
    onStart?: (input: RouteAttachmentOwnershipProviderStartInput) => void;
    attachmentCapable?: boolean;
  }> = {},
): Promise<RouteAttachmentOwnershipStartServices> {
  return {
    intents: {
      resolve: options.resolve ?? (() => Effect.succeed(authority)),
    },
    registry: await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry(
        [adapter(options.onStart, options.attachmentCapable)],
        { now: () => now },
      ),
    ),
    store: options.store ?? store(),
    environment: "staging",
    ids: {
      reservation: () => reservation.reservation_id,
      namespaceSession: () => reservation.namespace_session_id,
    },
  };
}

describe("route attachment ownership start", () => {
  test("starts outside storage transactions with attachment-only authority", async () => {
    let providerInput: RouteAttachmentOwnershipProviderStartInput | undefined;
    const result = await Effect.runPromise(
      startRouteAttachmentOwnership(
        input,
        await services({ onStart: (value) => (providerInput = value) }),
      ),
    );

    expect(result).toMatchObject({
      operation_kind: "route_attachment",
      community_id: "community-1",
      attachment_intent_id: "attachment-1",
      ceremony_intent_id: "attachment-ceremony-1",
      session_id: "attachment-namespace-session-1",
      status: "pending",
      replayed: false,
    });
    expect(providerInput).toBeDefined();
    expect(providerInput).not.toHaveProperty("creation_intent_id");
    const { request_hash, ...hashInput } =
      providerInput as RouteAttachmentOwnershipProviderStartInput;
    await expect(
      hnsRouteAttachmentStartHash({
        ...hashInput,
        provider_id: "hns.owner.v1",
      }),
    ).resolves.toBe(request_hash);
  });

  test("returns durable replay before resolving or calling the provider", async () => {
    let resolved = false;
    let providerCalled = false;
    const replayInput = {
      operation_kind: "route_attachment" as const,
      actor_id: authority.actor_id,
      community_id: authority.community_id,
      attachment_intent_id: authority.attachment_intent_id,
      ceremony_intent_id: authority.ceremony_intent_id,
      requirement_hash: authority.requirement_hash,
      generation: authority.generation,
      request_hash: "3".repeat(64),
      provider_binding_hash: authority.provider_binding_hash,
      provider_configuration: authority.provider_configuration,
      protocol_version: "hns-txt-v1",
      environment: "staging",
      route: authority.route,
    };
    const result = await Effect.runPromise(
      startRouteAttachmentOwnership(
        input,
        await services({
          onStart: () => (providerCalled = true),
          resolve: () => {
            resolved = true;
            return Effect.succeed(authority);
          },
          store: store({
            replay: () =>
              Effect.succeed({
                kind: "replay",
                namespace_session_id: reservation.namespace_session_id,
                start: started(replayInput),
              }),
          }),
        }),
      ),
    );
    expect(result).toMatchObject({ status: "pending", replayed: true });
    expect(resolved).toBe(false);
    expect(providerCalled).toBe(false);
  });

  test("releases its reservation when authority changes before provider work", async () => {
    let resolves = 0;
    let releases = 0;
    let providerCalled = false;
    const changed = { ...authority, generation: 2 };
    const effect = startRouteAttachmentOwnership(
      input,
      await services({
        onStart: () => (providerCalled = true),
        resolve: () => Effect.succeed(resolves++ === 0 ? authority : changed),
        store: store({
          release: () =>
            Effect.sync(() => {
              releases += 1;
            }),
        }),
      }),
    );
    await expect(Effect.runPromise(effect)).rejects.toBeInstanceOf(
      RouteAttachmentOwnershipStartRejected,
    );
    expect(releases).toBe(1);
    expect(providerCalled).toBe(false);
  });

  test("fails closed when the registered provider lacks attachment methods", async () => {
    await expect(
      Effect.runPromise(
        startRouteAttachmentOwnership(input, await services({ attachmentCapable: false })),
      ),
    ).rejects.toMatchObject({ reason: "unsupported" });
  });
});
