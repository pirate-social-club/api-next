import { describe, expect, test } from "bun:test";
import {
  encodeHnsOwnerTargetObservationV3,
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
const startContext = { namespace_session_id: "namespace-session-1" } as const;
const completeContext = {
  namespace_session_id: "namespace-session-1",
  observation_id: "completion-attempt-1",
} as const;

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

function targetResponse(overrides: Readonly<Record<string, unknown>> = {}) {
  return new TextEncoder().encode(
    JSON.stringify({
      status: "verified",
      observation_contract_version: "pirate-hns-target-observation-v2",
      provider_evidence_ref: `hns-observer-v1:sha256:${"5".repeat(64)}:target-1`,
      upstream_session_ref: "nvs_01",
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.xn--pokmon-dva",
      challenge_value: "pirate-verification=nvs_01",
      expected_txt_value_sha256: "6".repeat(64),
      control_identity_digest: "7".repeat(64),
      chain_authority_digest: "8".repeat(64),
      observer_result_sha256: "5".repeat(64),
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

async function targetV3Response(
  status: "verified" | "rejected" | "pending" | "unavailable" | "ineligible",
): Promise<Uint8Array> {
  const observerResult = "5".repeat(64);
  const snapshot = "9".repeat(64);
  if (status === "verified") {
    const challengeValue = "pirate-verification=nvs_01";
    const challengeHash = [
      ...new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(challengeValue)),
      ),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    return encodeHnsOwnerTargetObservationV3({
      status,
      observation_contract_version: "pirate-hns-target-observation-v3",
      provider_evidence_ref: `hns-observer-v2:sha256:${observerResult}:hns-observer:regtest:snapshot-01`,
      upstream_session_ref: "nvs_01",
      ownership_source: "owner_authoritative_dns_txt",
      challenge_name: "_pirate.xn--pokmon-dva",
      challenge_value: challengeValue,
      expected_txt_value_sha256: challengeHash,
      control_identity_digest: "7".repeat(64),
      chain_authority_digest: "8".repeat(64),
      observer_snapshot_sha256: snapshot,
      observer_result_sha256: observerResult,
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
    });
  }
  if (status === "rejected") {
    return encodeHnsOwnerTargetObservationV3({
      status: "rejected",
      observation_contract_version: "pirate-hns-target-observation-v3",
      reason_code: "root_absent",
      observer_snapshot_sha256: snapshot,
      observer_result_sha256: observerResult,
      provider_evidence_ref: `hns-observer-v2:sha256:${observerResult}:hns-observer:regtest:snapshot-01`,
    });
  }
  if (status === "pending") {
    return encodeHnsOwnerTargetObservationV3({
      status: "pending",
      observation_contract_version: "pirate-hns-target-observation-v3",
      reason_code: "txt_absent",
      observer_snapshot_sha256: snapshot,
      observer_result_sha256: observerResult,
      provider_evidence_ref: `hns-observer-v2:sha256:${observerResult}:hns-observer:regtest:snapshot-01`,
    });
  }
  if (status === "unavailable") {
    return encodeHnsOwnerTargetObservationV3({
      status,
      observation_contract_version: "pirate-hns-target-observation-v3",
      reason_code: "authority_inventory_unavailable",
      retry_after_seconds: 5,
      observer_snapshot_sha256: snapshot,
      diagnostic_ref: "hns-observer:regtest:snapshot-01",
    });
  }
  return encodeHnsOwnerTargetObservationV3({
    status,
    observation_contract_version: "pirate-hns-target-observation-v3",
    reason_code: "owner_authoritative_source_ineligible",
    ownership_source: "owner_authoritative_dns_txt",
    root_label: "xn--pokmon-dva",
    chain_authority_digest: "8".repeat(64),
    authority_inventory_reference: "authority-inventory:regtest-current",
    authority_inventory_version: "authority-inventory-v1",
    authority_inventory_digest: "a".repeat(64),
    observer_snapshot_sha256: snapshot,
    observer_result_sha256: observerResult,
    diagnostic_ref: "hns-observer:regtest:snapshot-01",
  });
}

function transport(
  options: Readonly<{
    readonly bytes?: Uint8Array;
    readonly startBytes?: Uint8Array;
    readonly failure?: boolean;
  }> = {},
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
        : Effect.succeed(
            options.startBytes ??
              new TextEncoder().encode(
                JSON.stringify({
                  upstream_session_ref: "nvs_01",
                  expires_at: "2026-08-20T13:00:00.000Z",
                  presentation: {
                    kind: "embedded_sdk" as const,
                    session_id: "nvs_01",
                    protocol: "hns-txt-challenge" as const,
                    version: "1" as const,
                    payload: {
                      ownership_source: "owner_authoritative_dns_txt" as const,
                      challenge_name: "_pirate.xn--pokmon-dva",
                      challenge_value: "pirate-verification=nvs_01",
                      expires_at: "2026-08-20T13:00:00.000Z",
                    },
                  },
                }),
              ),
          ),
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

function startResponseBytes(
  ownershipSource: "hns_parent_chain_txt" | "owner_authoritative_dns_txt",
  challengeName: string,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      upstream_session_ref: "nvs_01",
      expires_at: "2026-08-20T13:00:00.000Z",
      presentation: {
        kind: "embedded_sdk",
        session_id: "nvs_01",
        protocol: "hns-txt-challenge",
        version: "1",
        payload: {
          ownership_source: ownershipSource,
          challenge_name: challengeName,
          challenge_value: "pirate-verification=nvs_01",
          expires_at: "2026-08-20T13:00:00.000Z",
        },
      },
    }),
  );
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
    const started = await Effect.runPromise(provider.start(startInput, startContext));
    const result = await Effect.runPromise(
      provider.complete(
        {
          session: started.session,
          submission: { channel: "poll_result", payload: {} },
        },
        completeContext,
      ),
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
        provider.complete(
          {
            session: started.session,
            submission: { channel: "client_result", payload: {} },
          },
          completeContext,
        ),
      ),
    ).rejects.toBeDefined();
  });

  test("fences upstream session/challenge/time and rejects null expiry", async () => {
    const registry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter()], { now: () => now }),
    );
    const provider = await Effect.runPromise(registry.resolve("hns"));
    const started = await Effect.runPromise(provider.start(startInput, startContext));
    await expect(
      Effect.runPromise(
        provider.complete(
          {
            session: { ...started.session, upstream_session_ref: "different" },
            submission: { channel: "poll_result", payload: {} },
          },
          completeContext,
        ),
      ),
    ).rejects.toBeDefined();

    const badExpiry = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry([adapter(response({ expires_at: null }))], {
        now: () => now,
      }),
    );
    const badExpiryProvider = await Effect.runPromise(badExpiry.resolve("hns"));
    const badExpirySession = await Effect.runPromise(
      badExpiryProvider.start(startInput, startContext),
    );
    await expect(
      Effect.runPromise(
        badExpiryProvider.complete(
          {
            session: badExpirySession.session,
            submission: { channel: "poll_result", payload: {} },
          },
          completeContext,
        ),
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
    const contradictionSession = await Effect.runPromise(
      contradictionProvider.start(startInput, startContext),
    );
    await expect(
      Effect.runPromise(
        contradictionProvider.complete(
          {
            session: contradictionSession.session,
            submission: { channel: "poll_result", payload: {} },
          },
          completeContext,
        ),
      ),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderObservationRejected);

    const future = await Effect.runPromise(
      makeNamespaceOwnershipProviderRegistry(
        [adapter(response({ observed_at: "2026-08-20T12:00:00.001Z" }))],
        { now: () => now },
      ),
    );
    const futureProvider = await Effect.runPromise(future.resolve("hns"));
    const futureSession = await Effect.runPromise(futureProvider.start(startInput, startContext));
    await expect(
      Effect.runPromise(
        futureProvider.complete(
          {
            session: futureSession.session,
            submission: { channel: "poll_result", payload: {} },
          },
          completeContext,
        ),
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
    await expect(
      Effect.runPromise(provider.start(startInput, startContext)),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderUnavailable);
  });

  test("accepts both TXT topologies and rejects a source/name swap", async () => {
    for (const [ownershipSource, challengeName] of [
      ["hns_parent_chain_txt", "xn--pokmon-dva"],
      ["owner_authoritative_dns_txt", "_pirate.xn--pokmon-dva"],
    ] as const) {
      const provider = makeHnsOwnerAdapter({
        transport: transport({
          startBytes: startResponseBytes(ownershipSource, challengeName),
          bytes: response({ ownership_source: ownershipSource, challenge_name: challengeName }),
        }),
        provider_configuration,
        environments: ["staging"],
        now: () => now,
      });
      const started = await Effect.runPromise(provider.start(startInput, startContext));
      await expect(
        Effect.runPromise(
          provider.complete(
            { session: started.session, submission: { channel: "poll_result", payload: {} } },
            completeContext,
          ),
        ),
      ).resolves.toMatchObject({ status: "verified" });
    }

    const swapped = makeHnsOwnerAdapter({
      transport: transport({
        startBytes: startResponseBytes("hns_parent_chain_txt", "_pirate.xn--pokmon-dva"),
      }),
      provider_configuration,
      environments: ["staging"],
      now: () => now,
    });
    await expect(Effect.runPromise(swapped.start(startInput, startContext))).rejects.toBeInstanceOf(
      NamespaceOwnershipProviderInvalidResponse,
    );
  });

  test("rejects unsafe upstream session references at the direct adapter boundary", async () => {
    const safeTransport = transport();
    const provider = makeHnsOwnerAdapter({
      transport: {
        ...safeTransport,
        start: () =>
          Effect.succeed(
            new TextEncoder().encode(
              JSON.stringify({
                upstream_session_ref: "nvs\u0001unsafe",
                expires_at: "2026-08-20T13:00:00.000Z",
                presentation: {
                  kind: "embedded_sdk" as const,
                  session_id: "nvs\u0001unsafe",
                  protocol: "hns-txt-challenge" as const,
                  version: "1" as const,
                  payload: {
                    ownership_source: "owner_authoritative_dns_txt" as const,
                    challenge_name: "_pirate.xn--pokmon-dva",
                    challenge_value: "pirate-verification=nvs\u0001unsafe",
                    expires_at: "2026-08-20T13:00:00.000Z",
                  },
                },
              }),
            ),
          ),
      },
      provider_configuration,
      environments: ["staging"],
      now: () => now,
    });
    await expect(
      Effect.runPromise(provider.start(startInput, startContext)),
    ).rejects.toBeInstanceOf(NamespaceOwnershipProviderInvalidResponse);
  });

  test("returns every strict target-v3 disposition with its exact response authority", async () => {
    for (const status of [
      "verified",
      "rejected",
      "pending",
      "unavailable",
      "ineligible",
    ] as const) {
      const bytes = await targetV3Response(status);
      const provider = makeHnsOwnerAdapter({
        transport: transport({ bytes }),
        provider_configuration,
        environments: ["staging"],
        now: () => now,
        target_observation_contract: "v3",
      });
      const started = await Effect.runPromise(provider.start(startInput, startContext));
      const result = await Effect.runPromise(
        provider.complete(
          { session: started.session, submission: { channel: "poll_result", payload: {} } },
          completeContext,
        ),
      );
      expect(result.status).toBe(status);
      expect((result as { readonly raw_response_bytes: Uint8Array }).raw_response_bytes).toEqual(
        bytes,
      );
      expect(result).toMatchObject({
        observation: { observation_contract_version: "pirate-hns-target-observation-v3" },
      });
    }
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

  test("requires target-v2 observations in the production registry", async () => {
    async function completeWith(bytes: Uint8Array) {
      const registry = await Effect.runPromise(
        makePlatformNamespaceOwnershipProviderRegistry({
          now: () => now,
          hns: {
            enabled: true,
            transport: transport({ bytes }),
            provider_configuration,
            environments: ["staging"],
          },
        }),
      );
      const provider = await Effect.runPromise(registry.resolve("hns"));
      const started = await Effect.runPromise(provider.start(startInput, startContext));
      return Effect.runPromise(
        provider.complete(
          {
            session: started.session,
            submission: { channel: "poll_result", payload: {} },
          },
          completeContext,
        ),
      );
    }

    await expect(completeWith(response())).rejects.toBeInstanceOf(
      NamespaceOwnershipProviderInvalidResponse,
    );
    await expect(completeWith(targetResponse())).resolves.toMatchObject({
      status: "verified",
      observation: {
        observation_contract_version: "pirate-hns-target-observation-v2",
      },
    });
  });
});
