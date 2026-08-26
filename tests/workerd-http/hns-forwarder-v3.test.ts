/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test";
import type {
  HnsCommunityAppHostAuthorityStateV1,
  HnsHandlePersonaHostAuthorityStateV1,
  HnsHostAuthorityStateV1,
} from "@pirate/application/hns-host-serving";
import {
  makeHnsForwarderV3Gateway,
  makeHnsForwarderV3WorkerValidator,
  makeStaticHnsForwarderKeyRegistryV1,
} from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  disabledProductionHnsHostServingComposition,
  makeHnsHostServingComposition,
} from "../../apps/http-worker/src/hns-host-serving-composition.ts";

const now = 1_770_000_000;
const state: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: "app.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  community_id: "com_cmt_public_namespace_test",
  app_host_activation_id: "app_host_activation_01",
  app_host_activation_generation: 3,
  app_host_activation_status: "active",
  activation_dns_zone_id: "dns-zone-1",
  activation_dns_zone_generation: 4,
  activation_gateway_deployment_reference: "gateway-deployment-1",
  route_binding_id: "route-binding-1",
  route_binding_current: true,
  route_authority_kind: "operator_managed_route_v1",
  route_authority_reference: "operator_route_activation_01",
  route_authority_generation: 7,
  route_authority_effective: true,
  dns_zone: {
    dns_zone_activation_id: "dns-zone-1",
    dns_zone_activation_generation: 4,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: "gateway-deployment-1",
    gateway_certificate_spki_sha256: "a".repeat(64),
    gateway_health: "healthy",
  },
};
const handleState: HnsHandlePersonaHostAuthorityStateV1 = {
  variant: "handle_persona_v1",
  normalized_host: "name.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  canonical_handle_label: "name",
  community_id: "com_cmt_public_namespace_test",
  sale_namespace_activation_id: "sale_namespace_activation_01",
  sale_namespace_activation_generation: 3,
  sale_namespace_activation_status: "active",
  sale_namespace_dns_zone_id: "dns-zone-1",
  sale_namespace_dns_zone_generation: 4,
  sale_namespace_gateway_deployment_reference: "gateway-deployment-1",
  namespace_authority_kind: "verified_namespace_v1",
  namespace_authority_reference: "route_evidence_7",
  namespace_authority_generation: 7,
  namespace_authority_effective: true,
  handle_grant_id: "handle_grant_01",
  handle_grant_generation: 2,
  handle_grant_active: true,
  fulfillment_kind: "hosted_persona_v1",
  owner_persona_id: "persona_public_01",
  owner_persona_public: true,
  dns_zone: state.dns_zone,
};
const source = {
  resolve: (host: string) => Effect.succeed(host === state.normalized_host ? state : null),
};
const keyRegistry = makeStaticHnsForwarderKeyRegistryV1([
  {
    key_id: "gateway-key-2026-08",
    key_bytes: new TextEncoder().encode("test-forwarder-hmac-key-with-32-bytes"),
    signing_enabled: true,
    verify_not_before: now - 60,
    verify_not_after: now + 60,
  },
]);
const dependencies = {
  authority_source: source,
  key_registry: keyRegistry,
  replay_store: { consume: async () => true },
  clock: { nowUnixSeconds: () => now },
  limits: {
    max_body_bytes: 1_024,
    freshness_window_seconds: 30,
    future_clock_skew_seconds: 1,
  },
};

function dependenciesFor(authority: HnsHostAuthorityStateV1) {
  return {
    ...dependencies,
    authority_source: {
      resolve: (host: string) =>
        Effect.succeed(host === authority.normalized_host ? authority : null),
    },
  };
}

describe("HNS forwarder v3 in Workerd", () => {
  it("reproduces and verifies the frozen app-host vector", async () => {
    const gateway = makeHnsForwarderV3Gateway({
      ...dependencies,
      nonce_source: { next: () => "nonce-workerd" },
    });
    const worker = makeHnsForwarderV3WorkerValidator(dependencies);
    const envelope = await gateway.sign({
      method: "GET",
      normalized_host: state.normalized_host,
      path_and_query: "/c/xn--pokmon-dva",
      headers: new Headers(),
      body_bytes: new Uint8Array(),
    });
    expect(envelope.headers.get("x-pirate-hns-forwarder-signature")).toBe(
      "v3=b09e03ea0a1441654d481ca19f34245a4560f3db68b5abde3cda49f2bfb4f9eb",
    );
    await expect(
      worker.verify({
        method: "GET",
        url: "https://worker.internal/c/xn--pokmon-dva",
        headers: envelope.headers,
        body_bytes: new Uint8Array(),
      }),
    ).resolves.toMatchObject({
      normalized_host: state.normalized_host,
      community_id: state.community_id,
    });
  });

  it("reproduces and verifies the frozen read-only handle-host vector", async () => {
    const handleDependencies = dependenciesFor(handleState);
    const gateway = makeHnsForwarderV3Gateway({
      ...handleDependencies,
      nonce_source: { next: () => "unused-safe-method-nonce" },
    });
    const worker = makeHnsForwarderV3WorkerValidator(handleDependencies);
    const envelope = await gateway.sign({
      method: "GET",
      normalized_host: handleState.normalized_host,
      path_and_query: "/",
      headers: new Headers({ Cookie: "session=must-not-cross" }),
      body_bytes: new Uint8Array(),
    });
    expect(envelope.headers.get("x-pirate-hns-forwarder-signature")).toBe(
      "v3=91716ea3c434df9b5fba3e5f177b2db6b0beac25cd81bb3906faf5fce8e338de",
    );
    expect(envelope.headers.has("cookie")).toBe(false);
    await expect(
      worker.verify({
        method: "GET",
        url: "https://worker.internal/",
        headers: envelope.headers,
        body_bytes: new Uint8Array(),
      }),
    ).resolves.toMatchObject({ state: { variant: "handle_persona_v1" } });
  });

  it("keeps exported production composition disabled and unconfigured", () => {
    expect(makeHnsHostServingComposition(false, dependencies)).toEqual({
      enabled: false,
      validator: null,
    });
    expect(disabledProductionHnsHostServingComposition).toEqual({
      enabled: false,
      validator: null,
    });
    const bindings = env as unknown as Record<string, unknown>;
    expect("HNS_FORWARDER_KEY_REGISTRY" in bindings).toBe(false);
    expect("HNS_HOST_AUTHORITY" in bindings).toBe(false);
    expect("HNS_HOST_SERVING_ENABLED" in bindings).toBe(false);
  });
});
