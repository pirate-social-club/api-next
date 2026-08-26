import { describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import type { HnsCommunityAppHostAuthorityStateV1 } from "@pirate/application/hns-host-serving";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import {
  assembleHnsCommunityAppGatewayRuntime,
  embeddedApiNextSourceCommit,
  listenersForMode,
  parseHnsCommunityAppGatewayArguments,
} from "./community-main.ts";
import {
  HNS_COMMUNITY_APP_GATEWAY_PRODUCTION_LISTENERS,
  HNS_COMMUNITY_APP_GATEWAY_SHADOW_LISTENERS,
  HNS_COMMUNITY_APP_GATEWAY_STAGING_SHADOW_LISTENERS,
  type HnsCommunityAppGatewayRuntimeConfigurationV1,
} from "./community-runtime-config.ts";
import { HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, HNS_GATEWAY_TLS_SNI_HEADER } from "./request.ts";
import { startHnsCommunityAppGatewayServer } from "./server.ts";

const host = "app.community-root";
const deploymentReference = `hns-community-app-gateway-sha256:${"a".repeat(64)}`;

const activeState: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: host,
  canonical_root: "community-root",
  community_id: "community-01",
  app_host_activation_id: "activation-01",
  app_host_activation_generation: 1,
  app_host_activation_status: "active",
  activation_dns_zone_id: "dns-zone-01",
  activation_dns_zone_generation: 1,
  activation_gateway_deployment_reference: deploymentReference,
  route_binding_id: "route-binding-01",
  route_binding_current: true,
  route_authority_kind: "operator_managed_route_v1",
  route_authority_reference: "operator-route-01",
  route_authority_generation: 1,
  route_authority_effective: true,
  dns_zone: {
    dns_zone_activation_id: "dns-zone-01",
    dns_zone_activation_generation: 1,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: deploymentReference,
    gateway_certificate_spki_sha256: "b".repeat(64),
    gateway_health: "healthy",
  },
};

function configuration(): HnsCommunityAppGatewayRuntimeConfigurationV1 {
  return {
    manifest: {
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

function gatewayRequest(method: "GET" | "POST", body = new Uint8Array()) {
  return {
    method,
    target: method === "GET" ? "/" : "/api/test",
    header_fields: [
      ["Host", host],
      [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
      [HNS_GATEWAY_TLS_SNI_HEADER, host],
      ...(method === "POST"
        ? ([
            ["Origin", `https://${host}`],
            ["Content-Length", String(body.byteLength)],
            ["CF-Access-Client-Id", "browser-forgery"],
            ["CF-Access-Client-Secret", "browser-forgery"],
          ] as const)
        : []),
    ] as const,
    body_bytes: body,
    signal: new AbortController().signal,
  };
}

function listenOnLoopback(port: number): Promise<Server> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

describe("community gateway executable assembly", () => {
  test("accepts only the exact mode and absolute manifest arguments", () => {
    expect(
      parseHnsCommunityAppGatewayArguments([
        "--mode",
        "production",
        "--manifest",
        "/srv/pirate-hns-community-app-gateway/current/deployment-manifest.json",
      ]),
    ).toEqual({
      mode: "production",
      manifest_path: "/srv/pirate-hns-community-app-gateway/current/deployment-manifest.json",
    });
    expect(
      parseHnsCommunityAppGatewayArguments([
        "--mode",
        "staging-shadow",
        "--manifest",
        "/srv/pirate-hns-community-app-gateway-staging-shadow/current/deployment-manifest.json",
      ]),
    ).toEqual({
      mode: "staging-shadow",
      manifest_path:
        "/srv/pirate-hns-community-app-gateway-staging-shadow/current/deployment-manifest.json",
    });
    for (const arguments_ of [
      [],
      ["--mode", "other", "--manifest", "/manifest.json"],
      ["--mode", "shadow", "--manifest", "relative.json"],
      ["--manifest", "/manifest.json", "--mode", "shadow"],
    ]) {
      expect(() => parseHnsCommunityAppGatewayArguments(arguments_)).toThrow(
        "arguments are invalid",
      );
    }
    expect(HNS_COMMUNITY_APP_GATEWAY_PRODUCTION_LISTENERS).toEqual({
      gateway_host: "127.0.0.1",
      gateway_port: 4069,
      health_host: "127.0.0.1",
      health_port: 4071,
    });
    expect(HNS_COMMUNITY_APP_GATEWAY_SHADOW_LISTENERS).toEqual({
      gateway_host: "127.0.0.1",
      gateway_port: 4169,
      health_host: "127.0.0.1",
      health_port: 4171,
    });
    expect(HNS_COMMUNITY_APP_GATEWAY_STAGING_SHADOW_LISTENERS).toEqual({
      gateway_host: "127.0.0.1",
      gateway_port: 4269,
      health_host: "127.0.0.1",
      health_port: 4271,
    });
    expect(listenersForMode("staging-shadow")).toBe(
      HNS_COMMUNITY_APP_GATEWAY_STAGING_SHADOW_LISTENERS,
    );
  });

  test("binds the staging pair while every production pair remains independently owned", async () => {
    const productionPorts = [4069, 4071, 4169, 4171];
    const productionServers: Server[] = [];
    let stagingServer: Awaited<ReturnType<typeof startHnsCommunityAppGatewayServer>> | undefined;
    try {
      for (const port of productionPorts) productionServers.push(await listenOnLoopback(port));
      const runtime = assembleHnsCommunityAppGatewayRuntime({
        configuration: configuration(),
        authority_factory: () => ({
          authority_source: { resolve: () => Effect.succeed(null) },
          ready: async () => true,
        }),
        fetch_impl: async () => new Response(null, { status: 421 }),
      });
      stagingServer = await startHnsCommunityAppGatewayServer({
        composition: runtime.composition,
        ...listenersForMode("staging-shadow"),
        ready: runtime.ready,
      });
      expect(stagingServer.gateway_address).toEqual({ host: "127.0.0.1", port: 4269 });
      expect(stagingServer.health_address).toEqual({ host: "127.0.0.1", port: 4271 });
    } finally {
      await Promise.all([
        ...(stagingServer === undefined ? [] : [stagingServer.stop()]),
        ...productionServers.map(closeServer),
      ]);
    }
  });

  test("refuses source execution without build-injected commit provenance", () => {
    expect(() => embeddedApiNextSourceCommit()).toThrow("build provenance is invalid");
  });

  test("keeps readiness closed and injects credentials only on protected Solid requests", async () => {
    const calls: Request[] = [];
    const runtime = assembleHnsCommunityAppGatewayRuntime({
      configuration: configuration(),
      authority_factory: () => ({
        authority_source: {
          resolve: (normalizedHost) => Effect.succeed(normalizedHost === host ? activeState : null),
        },
        ready: async () => true,
      }),
      fetch_impl: async (input, init) => {
        const request =
          input instanceof Request
            ? input
            : new Request(input instanceof URL ? input.href : input, init);
        calls.push(request);
        return request.method === "HEAD" ? new Response(null, { status: 421 }) : new Response("ok");
      },
    });
    expect(await runtime.ready()).toBe(true);
    if (!runtime.composition.enabled) throw new Error("expected enabled composition");
    expect((await runtime.composition.service.handle(gatewayRequest("GET"))).status).toBe(200);
    const body = new TextEncoder().encode("payload");
    expect((await runtime.composition.service.handle(gatewayRequest("POST", body))).status).toBe(
      200,
    );
    expect((await runtime.composition.service.handle(gatewayRequest("POST", body))).status).toBe(
      200,
    );

    expect(calls).toHaveLength(4);
    for (const request of calls) {
      expect(request.headers.get("cf-access-client-id")).toBe("gateway-access-client-id");
      expect(request.headers.get("cf-access-client-secret")).toBe("gateway-access-client-secret");
    }
    const nonces = calls
      .slice(2)
      .map((request) => request.headers.get("x-pirate-hns-forwarder-nonce"));
    expect(nonces[0]).toMatch(/^[0-9a-f]{48}$/u);
    expect(nonces[1]).toMatch(/^[0-9a-f]{48}$/u);
    expect(nonces[0]).not.toBe(nonces[1]);

    let solidCalled = false;
    const unavailable = assembleHnsCommunityAppGatewayRuntime({
      configuration: configuration(),
      authority_factory: () => ({
        authority_source: { resolve: () => Effect.succeed(null) },
        ready: async () => false,
      }),
      fetch_impl: async () => {
        solidCalled = true;
        return new Response();
      },
    });
    expect(await unavailable.ready()).toBe(false);
    expect(solidCalled).toBe(false);
  });
});
