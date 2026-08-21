import { describe, expect, test } from "bun:test";
import {
  makeNamespaceOwnershipProviderRegistry,
  NamespaceOwnershipProviderInvalidResponse,
  NamespaceOwnershipProviderObservationRejected,
  NamespaceOwnershipProviderUnavailable,
} from "@pirate/application";
import { Effect } from "effect";
import { type HnsOwnerTransport, makeHnsOwnerAdapter } from "./hns-owner.ts";
import { makePlatformNamespaceOwnershipProviderRegistry } from "./provider-registry.ts";

const now = Date.parse("2026-08-20T12:00:00.000Z");
const route = {
  family: "hns" as const,
  root_label: "xn--pokmon-dva",
  root_label_display: "pokémon",
  path_segment: "app.xn--pokmon-dva",
  href: "/c/app.xn--pokmon-dva",
  app_host: null,
};
const provider_configuration = {
  kind: "managed" as const,
  reference: "hns-owner-staging",
  version: "hns-owner-config-v1",
};
const startInput = {
  actor_id: "user-1",
  creation_intent_id: "cc_intent-1",
  ceremony_intent_id: "cc_ceremony-1",
  requirement_hash: "1".repeat(64),
  generation: 1,
  request_hash: "2".repeat(64),
  provider_binding_hash: "3".repeat(64),
  provider_configuration,
  protocol_version: "hns-txt-v1",
  environment: "staging",
  route,
};

function response(overrides: Readonly<Record<string, unknown>> = {}) {
  return new TextEncoder().encode(
    JSON.stringify({
      status: "verified",
      provider_evidence_ref: "provider-observation-1",
      upstream_session_ref: "nvs_01",
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.xn--pokmon-dva",
      challenge_value: "pirate-verification=nvs_01",
      root_exists: true,
      root_control_verified: true,
      expiry_horizon_sufficient: true,
      chain_network: "regtest",
      chain_anchor_height: 123456,
      chain_anchor_block_hash: "4".repeat(64),
      chain_anchor_median_time: 1769999900,
      expiry_height: 200000,
      observed_at: "2026-08-20T11:00:00.000Z",
      expires_at: "2026-08-20T13:00:00.000Z",
      ...overrides,
    }),
  );
}

function transport(
  options: Readonly<{ readonly bytes?: Uint8Array; readonly failure?: boolean }> = {},
): HnsOwnerTransport {
  return {
    start: () =>
      options.failure
        ? Effect.fail(
            new NamespaceOwnershipProviderUnavailable({
              provider_id: "hns.owner.v1",
              operation: "start",
            }),
          )
        : Effect.succeed({
            upstream_session_ref: "nvs_01",
            expires_at: "2026-08-20T13:00:00.000Z",
            presentation: {
              kind: "poll" as const,
              session_id: "nvs_01",
              poll_url: "/hns-owner/nvs_01",
            },
          }),
    poll: () =>
      options.failure
        ? Effect.fail(
            new NamespaceOwnershipProviderUnavailable({
              provider_id: "hns.owner.v1",
              operation: "complete",
            }),
          )
        : Effect.succeed(options.bytes ?? response()),
  };
}

function adapter(bytes?: Uint8Array) {
  return makeHnsOwnerAdapter({
    transport: transport(bytes === undefined ? {} : { bytes }),
    provider_configuration,
    environments: ["staging"],
    now: () => now,
  });
}

describe("injected HNS owner adapter", () => {
  test("supports only HNS/poll_result and returns exact raw bytes without authority digests", async () => {
    const bytes = response();
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter(bytes)], { now: () => now }),
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));
    await expect(
      Effect.runPromise(provider.plan({ route, environment: "staging" })),
    ).resolves.toEqual({
      status: "supported",
      provider_configuration,
      protocol_version: "hns-txt-v1",
    });
    const started = await Effect.runPromise(provider.start(startInput));
    const result = await Effect.runPromise(
      provider.complete({
        session: started.session,
        submission: { channel: "poll_result", payload: {} },
      }),
    );
    expect(result).toMatchObject({
      status: "verified",
      evidence_kind: "raw_provider_response_v1",
      provider_evidence_ref: "provider-observation-1",
      observation: { upstream_session_ref: "nvs_01" },
    });
    expect((result as { readonly raw_response_bytes: Uint8Array }).raw_response_bytes).toEqual(
      bytes,
    );
    expect(result).not.toHaveProperty("evidence_ref");
    expect(result).not.toHaveProperty("evidence_digest");
    expect(result).not.toHaveProperty("provider_identity_digest");
    await expect(
      Effect.runPromise(
        provider.plan({ route: { ...route, family: "spaces" } as never, environment: "staging" }),
      ),
    ).rejects.toBeDefined();
    await expect(
      Effect.runPromise(
        provider.complete({
          session: started.session,
          submission: { channel: "client_result", payload: {} },
        }),
      ),
    ).rejects.toBeDefined();
  });

  test("fences upstream session/challenge/time and rejects null expiry", async () => {
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter()], { now: () => now }),
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));
    const started = await Effect.runPromise(provider.start(startInput));
    await expect(
      Effect.runPromise(
        provider.complete({
          session: { ...started.session, upstream_session_ref: "different" },
          submission: { channel: "poll_result", payload: {} },
        }),
      ),
    ).rejects.toBeDefined();

    const badExpiry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter(response({ expires_at: null }))], {
        now: () => now,
      }),
    );
    const badExpiryProvider = await Effect.runPromise(badExpiry.resolve("hns"));
    const badExpirySession = await Effect.runPromise(badExpiryProvider.start(startInput));
    await expect(
      Effect.runPromise(
        badExpiryProvider.complete({
          session: badExpirySession.session,
          submission: { channel: "poll_result", payload: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);

    const contradiction = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry(
        [adapter(response({ root_control_verified: false }))],
        {
          now: () => now,
        },
      ),
    );
    const contradictionProvider = await Effect.runPromise(contradiction.resolve("hns"));
    const contradictionSession = await Effect.runPromise(contradictionProvider.start(startInput));
    await expect(
      Effect.runPromise(
        contradictionProvider.complete({
          session: contradictionSession.session,
          submission: { channel: "poll_result", payload: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderObservationRejected);

    const future = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry(
        [adapter(response({ observed_at: "2026-08-20T12:00:00.001Z" }))],
        { now: () => now },
      ),
    );
    const futureProvider = await Effect.runPromise(future.resolve("hns"));
    const futureSession = await Effect.runPromise(futureProvider.start(startInput));
    await expect(
      Effect.runPromise(
        futureProvider.complete({
          session: futureSession.session,
          submission: { channel: "poll_result", payload: {} },
        }),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);
  });

  test("preserves injected transport failures", async () => {
    const provider = makeHnsOwnerAdapter({
      transport: transport({ failure: true }),
      provider_configuration,
      environments: ["staging"],
      now: () => now,
    });
    await expect(Effect.runPromise(provider.start(startInput))).rejects.toBeInstanceOf(
      NamespaceOwnershipProviderUnavailable,
    );
  });

  test("rejects unsafe upstream session references at the direct adapter boundary", async () => {
    const safeTransport = transport();
    const provider = makeHnsOwnerAdapter({
      transport: {
        ...safeTransport,
        start: () =>
          Effect.succeed({
            upstream_session_ref: "nvs\u0001unsafe",
            expires_at: "2026-08-20T13:00:00.000Z",
            presentation: {
              kind: "poll" as const,
              session_id: "nvs\u0001unsafe",
              poll_url: "/hns-owner/unsafe",
            },
          }),
      },
      provider_configuration,
      environments: ["staging"],
      now: () => now,
    });
    await expect(Effect.runPromise(provider.start(startInput))).rejects.toBeInstanceOf(
      NamespaceOwnershipProviderInvalidResponse,
    );
  });
});

describe("HNS provider platform assembly", () => {
  test("is empty by default and when configuration is incomplete", async () => {
    const disabled = await Effect.runPromise(makePlatformNamespaceOwnershipProviderRegistry());
    expect(disabled.list()).toEqual([]);
    const incomplete = await Effect.runPromise(
      makePlatformNamespaceOwnershipProviderRegistry({
        hns: { enabled: true, provider_configuration },
      }),
    );
    expect(incomplete.list()).toEqual([]);
  });

  test("constructs HNS lazily only from a complete explicit injected configuration", async () => {
    const registry = await Effect.runPromise(
      makePlatformNamespaceOwnershipProviderRegistry({
        now: () => now,
        hns: {
          enabled: true,
          transport: transport(),
          provider_configuration,
          environments: ["staging"],
        },
      }),
    );
    expect(registry.list()).toEqual([
      expect.objectContaining({
        provider_id: "hns.owner.v1",
        supported_families: ["hns"],
        submission_channels: ["poll_result"],
      }),
    ]);
  });
});
