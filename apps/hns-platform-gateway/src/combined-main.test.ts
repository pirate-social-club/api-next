import { describe, expect, test } from "bun:test";
import type {
  HnsCommunityAppHostAuthorityStateV1,
  HnsHandlePersonaHostAuthorityStateV1,
} from "@pirate/application/hns-host-serving";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import {
  assembleHnsCommunityAppHandleGatewayRuntime,
  embeddedCombinedApiNextSourceCommit,
  parseHnsCommunityAppHandleGatewayArguments,
} from "./combined-main.ts";
import {
  HNS_COMMUNITY_APP_HANDLE_GATEWAY_DEPLOYMENT_SCHEMA,
  type HnsCommunityAppGatewayRuntimeConfigurationV1,
} from "./community-runtime-config.ts";
import { HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, HNS_GATEWAY_TLS_SNI_HEADER } from "./request.ts";

const deploymentReference = `hns-community-app-handle-gateway-sha256:${"a".repeat(64)}`;
const appHost = "app.jazleeuw";
const handleHost = "pilotuser.jazleeuw";

const dns = {
  dns_zone_activation_id: "dns-zone-01",
  dns_zone_activation_generation: 8,
  status: "active" as const,
  stable_chain_delegation_matches: true,
  dnssec_ds_authenticates_zone: true,
  retained_zone_digest_matches: true,
  gateway_deployment_reference: deploymentReference,
  gateway_certificate_spki_sha256: "b".repeat(64),
  gateway_health: "healthy" as const,
};

const appState: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: appHost,
  canonical_root: "jazleeuw",
  community_id: "community-01",
  app_host_activation_id: "activation-01",
  app_host_activation_generation: 13,
  app_host_activation_status: "active",
  activation_dns_zone_id: dns.dns_zone_activation_id,
  activation_dns_zone_generation: dns.dns_zone_activation_generation,
  activation_gateway_deployment_reference: deploymentReference,
  route_binding_id: "route-binding-01",
  route_binding_current: true,
  route_authority_kind: "verified_namespace_v1",
  route_authority_reference: "route-evidence-01",
  route_authority_generation: 2,
  route_authority_effective: true,
  dns_zone: dns,
};

const handleState: HnsHandlePersonaHostAuthorityStateV1 = {
  variant: "handle_persona_v1",
  normalized_host: handleHost,
  canonical_root: "jazleeuw",
  canonical_handle_label: "pilotuser",
  community_id: "community-01",
  sale_namespace_activation_id: "sale-namespace-01",
  sale_namespace_activation_generation: 1,
  sale_namespace_activation_status: "active",
  sale_namespace_dns_zone_id: dns.dns_zone_activation_id,
  sale_namespace_dns_zone_generation: dns.dns_zone_activation_generation,
  sale_namespace_gateway_deployment_reference: deploymentReference,
  namespace_authority_kind: "verified_namespace_v1",
  namespace_authority_reference: "route-evidence-01",
  namespace_authority_generation: 2,
  namespace_authority_effective: true,
  handle_grant_id: "handle-grant-01",
  handle_grant_generation: 1,
  handle_grant_active: true,
  fulfillment_kind: "hosted_persona_v1",
  owner_persona_id: "persona-public-01",
  owner_persona_public: true,
  dns_zone: dns,
};

function configuration(): HnsCommunityAppGatewayRuntimeConfigurationV1 {
  return {
    manifest: {
      schema: HNS_COMMUNITY_APP_HANDLE_GATEWAY_DEPLOYMENT_SCHEMA,
      solid_origin: "https://hns-solid-staging.pirate.sc",
      private_authority_deadline_milliseconds: 2_000,
    } as HnsCommunityAppGatewayRuntimeConfigurationV1["manifest"],
    gateway_deployment_reference: deploymentReference,
    authority_database_url: "postgresql://gateway:private@db.example/api_next?sslmode=verify-full",
    solid_access_client_id: "gateway-access-client-id",
    solid_access_client_secret: "gateway-access-client-secret",
    key_registry: makeStaticHnsForwarderKeyRegistryV1([
      {
        key_id: "gateway-key-01",
        key_bytes: new Uint8Array(32).fill(3),
        signing_enabled: true,
        verify_not_before: 0,
        verify_not_after: Number.MAX_SAFE_INTEGER,
      },
    ]),
    forwarder_limits: {
      max_body_bytes: 1_048_576,
      freshness_window_seconds: 300,
      future_clock_skew_seconds: 5,
    },
  };
}

function request(host: string) {
  return {
    method: "GET",
    target: "/",
    header_fields: [
      ["Host", host],
      [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
      [HNS_GATEWAY_TLS_SNI_HEADER, host],
    ] as const,
    body_bytes: new Uint8Array(),
    signal: new AbortController().signal,
  };
}

describe("combined community app and handle gateway executable", () => {
  test("accepts only production and shadow with an absolute manifest", () => {
    expect(
      parseHnsCommunityAppHandleGatewayArguments([
        "--mode",
        "production",
        "--manifest",
        "/srv/pirate-hns-community-app-handle-gateway/current/deployment-manifest.json",
      ]),
    ).toEqual({
      mode: "production",
      manifest_path:
        "/srv/pirate-hns-community-app-handle-gateway/current/deployment-manifest.json",
    });
    for (const arguments_ of [
      [],
      ["--mode", "staging-shadow", "--manifest", "/manifest.json"],
      ["--mode", "shadow", "--manifest", "relative.json"],
      ["--manifest", "/manifest.json", "--mode", "shadow"],
    ]) {
      expect(() => parseHnsCommunityAppHandleGatewayArguments(arguments_)).toThrow(
        "arguments are invalid",
      );
    }
  });

  test("refuses source execution without build-injected commit provenance", () => {
    expect(() => embeddedCombinedApiNextSourceCommit()).toThrow("build provenance is invalid");
  });

  test("serves app and handle hosts through one deployment-bound runtime", async () => {
    const calls: Request[] = [];
    const runtime = assembleHnsCommunityAppHandleGatewayRuntime({
      configuration: configuration(),
      authority_factory: () => ({
        community_authority_source: {
          resolve: (host) => Effect.succeed(host === appHost ? appState : null),
        },
        handle_authority_source: {
          resolve: (host) => Effect.succeed(host === handleHost ? handleState : null),
        },
        ready: async () => true,
      }),
      fetch_impl: async (input, init) => {
        const upstream =
          input instanceof Request
            ? input
            : new Request(input instanceof URL ? input.href : input, init);
        calls.push(upstream);
        return upstream.method === "HEAD"
          ? new Response(null, { status: 421 })
          : new Response("surface", {
              status: 200,
              headers: { "content-type": "text/html; charset=utf-8" },
            });
      },
    });
    expect(await runtime.ready()).toBe(true);
    if (!runtime.composition.enabled) throw new Error("expected enabled composition");
    expect((await runtime.composition.service.handle(request(appHost))).status).toBe(200);
    expect((await runtime.composition.service.handle(request(handleHost))).status).toBe(200);
    expect(calls).toHaveLength(3);
    for (const upstream of calls) {
      expect(upstream.headers.get("cf-access-client-id")).toBe("gateway-access-client-id");
      expect(upstream.headers.get("cf-access-client-secret")).toBe("gateway-access-client-secret");
    }
  });

  test("rejects the legacy community-only manifest at assembly", () => {
    const legacy = configuration();
    const input = {
      ...legacy,
      manifest: { ...legacy.manifest, schema: "pirate-hns-community-app-gateway-deployment-v1" },
    } as HnsCommunityAppGatewayRuntimeConfigurationV1;
    expect(() => assembleHnsCommunityAppHandleGatewayRuntime({ configuration: input })).toThrow(
      "configuration is incomplete or invalid",
    );
  });
});
