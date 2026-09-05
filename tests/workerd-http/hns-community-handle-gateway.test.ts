/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { encodeHnsCommunityHandlePersonaGatewayProfileV2 } from "@pirate/application/hns-community-handle-gateway";
import type { HnsHandlePersonaHostAuthorityStateV1 } from "@pirate/application/hns-host-serving";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { makeHnsCommunityHandleGatewayComposition } from "../../apps/hns-platform-gateway/src/handle-composition.ts";
import {
  HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
  HNS_GATEWAY_TLS_SNI_HEADER,
} from "../../apps/hns-platform-gateway/src/request.ts";

const now = 1_770_000_000;
const deployment = "gateway-deployment-handle-workerd";
const state: HnsHandlePersonaHostAuthorityStateV1 = {
  variant: "handle_persona_v1",
  normalized_host: "name.charizard",
  canonical_root: "charizard",
  canonical_handle_label: "name",
  community_id: "community-handle-workerd",
  sale_namespace_activation_id: "sale-activation-workerd",
  sale_namespace_activation_generation: 2,
  sale_namespace_activation_status: "active",
  sale_namespace_dns_zone_id: "dns-handle-workerd",
  sale_namespace_dns_zone_generation: 1,
  sale_namespace_gateway_deployment_reference: deployment,
  namespace_authority_kind: "verified_namespace_v1",
  namespace_authority_reference: "evidence-handle-workerd",
  namespace_authority_generation: 1,
  namespace_authority_effective: true,
  handle_grant_id: "grant-handle-workerd",
  handle_grant_generation: 1,
  handle_grant_active: true,
  fulfillment_kind: "hosted_persona_v1",
  owner_persona_id: "persona-handle-workerd",
  owner_persona_public: true,
  dns_zone: {
    dns_zone_activation_id: "dns-handle-workerd",
    dns_zone_activation_generation: 1,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: deployment,
    gateway_certificate_spki_sha256: "b".repeat(64),
    gateway_health: "healthy",
  },
};

function request(method: "GET" | "HEAD", target = "/") {
  return {
    method,
    target,
    header_fields: [
      ["host", state.normalized_host],
      [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
      [HNS_GATEWAY_TLS_SNI_HEADER, state.normalized_host],
      ["cookie", "must-not-cross"],
    ] as const,
    body_bytes: new Uint8Array(),
    signal: new AbortController().signal,
  };
}

describe("HNS community handle gateway in Workerd", () => {
  it("proxies exact GET and HEAD roots without browser identity or private headers", async () => {
    const observed: Request[] = [];
    const composition = makeHnsCommunityHandleGatewayComposition(true, {
      profile_bytes: encodeHnsCommunityHandlePersonaGatewayProfileV2(),
      gateway_deployment_reference: deployment,
      solid_origin: "https://solid.internal",
      solid_access_client_id: "access-id",
      solid_access_client_secret: "access-secret",
      authority_source: { resolve: () => Effect.succeed(state) },
      key_registry: makeStaticHnsForwarderKeyRegistryV1([
        {
          key_id: "handle-workerd-key",
          key_bytes: new Uint8Array(32).fill(19),
          signing_enabled: true,
          verify_not_before: now - 60,
          verify_not_after: now + 60,
        },
      ]),
      clock: { nowUnixSeconds: () => now },
      nonce_source: { next: () => "" },
      forwarder_limits: {
        max_body_bytes: 0,
        freshness_window_seconds: 30,
        future_clock_skew_seconds: 1,
      },
      upstream_fetch: (upstream) => {
        observed.push(upstream);
        return new Response(upstream.method === "HEAD" ? null : "persona", {
          headers: { "content-type": "text/html", "x-private": "remove" },
        });
      },
    });
    if (!composition.enabled) throw new Error("handle gateway did not enable");

    const get = await composition.service.handle(request("GET"));
    const head = await composition.service.handle(request("HEAD"));
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("persona");
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    expect(get.headers.get("cache-control")).toBe("no-store");
    expect(head.headers.get("cache-control")).toBe("no-store");
    expect(get.headers.get("x-private")).toBeNull();
    expect(observed).toHaveLength(2);
    for (const upstream of observed) {
      expect(upstream.url).toBe("https://solid.internal/");
      expect(upstream.headers.get("cookie")).toBeNull();
      expect(upstream.headers.get("cf-access-client-id")).toBe("access-id");
      expect(upstream.headers.get("cf-access-client-secret")).toBe("access-secret");
    }
    expect((await composition.service.handle(request("GET", "/?q=1"))).status).toBe(400);
  });
});
