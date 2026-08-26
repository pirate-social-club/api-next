import { afterEach, describe, expect, test } from "bun:test";
import {
  encodeHnsCommunityAppInteractiveGatewayProfileV2,
  HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE,
} from "@pirate/application/hns-community-app-gateway";
import {
  HNS_FORWARDER_HOST_HEADER,
  HNS_FORWARDER_NONCE_HEADER,
  HNS_FORWARDER_PATH_HEADER,
  HNS_FORWARDER_SIGNATURE_HEADER,
} from "@pirate/application/hns-forwarder-v3";
import type { HnsCommunityAppHostAuthorityStateV1 } from "@pirate/application/hns-host-serving";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import {
  disabledProductionHnsCommunityAppGatewayComposition,
  makeHnsCommunityAppGatewayComposition,
} from "./community-composition.ts";
import {
  HnsCommunityAppGatewayCallerAbort,
  makeHnsCommunityAppGatewayService,
} from "./community-service.ts";
import {
  HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
  HNS_GATEWAY_TLS_SNI_HEADER,
  type HnsStaticPlatformGatewayHeaderField,
  type HnsStaticPlatformGatewayRequest,
} from "./request.ts";
import { startHnsCommunityAppGatewayServer } from "./server.ts";

const now = 1_770_000_000;
const host = "app.xn--pokmon-dva";
const root = "xn--pokmon-dva";
const deploymentReference = "gateway-deployment-01";
const secret = new TextEncoder().encode("test-forwarder-hmac-key-with-32-bytes");
const activeState: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: host,
  canonical_root: root,
  community_id: "community-public-01",
  app_host_activation_id: "activation-01",
  app_host_activation_generation: 3,
  app_host_activation_status: "active",
  activation_dns_zone_id: "dns-zone-01",
  activation_dns_zone_generation: 2,
  activation_gateway_deployment_reference: deploymentReference,
  route_binding_id: "route-binding-01",
  route_binding_current: true,
  route_authority_kind: "operator_managed_route_v1",
  route_authority_reference: "operator-activation-01",
  route_authority_generation: 7,
  route_authority_effective: true,
  dns_zone: {
    dns_zone_activation_id: "dns-zone-01",
    dns_zone_activation_generation: 2,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: deploymentReference,
    gateway_certificate_spki_sha256: "a".repeat(64),
    gateway_health: "healthy",
  },
};
const runningServers: Array<{ stop: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
});

function request(
  overrides: Partial<HnsStaticPlatformGatewayRequest> = {},
): HnsStaticPlatformGatewayRequest {
  return {
    method: "GET",
    target: "/",
    header_fields: [
      ["Host", host],
      [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
      [HNS_GATEWAY_TLS_SNI_HEADER, host],
    ],
    body_bytes: new Uint8Array(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function keyRegistry() {
  return makeStaticHnsForwarderKeyRegistryV1([
    {
      key_id: "gateway-key-test",
      key_bytes: secret,
      signing_enabled: true,
      verify_not_before: now - 3_600,
      verify_not_after: now + 3_600,
    },
  ]);
}

function composition(input: {
  current?: HnsCommunityAppHostAuthorityStateV1 | null;
  fetch?: (request: Request) => Promise<Response> | Response;
  deployment_reference?: string;
}) {
  const current = input.current === undefined ? activeState : input.current;
  return makeHnsCommunityAppGatewayComposition(true, {
    profile_bytes: encodeHnsCommunityAppInteractiveGatewayProfileV2(),
    gateway_deployment_reference: input.deployment_reference ?? deploymentReference,
    solid_origin: "https://solid.example",
    solid_access_client_id: "gateway-access-client-id",
    solid_access_client_secret: "gateway-access-client-secret",
    authority_source: {
      resolve: (normalizedHost) =>
        Effect.succeed(current?.normalized_host === normalizedHost ? current : null),
    },
    key_registry: keyRegistry(),
    clock: { nowUnixSeconds: () => now },
    nonce_source: { next: () => "nonce-01" },
    forwarder_limits: {
      max_body_bytes: HNS_COMMUNITY_APP_INTERACTIVE_GATEWAY_PROFILE[11],
      freshness_window_seconds: 300,
      future_clock_skew_seconds: 5,
    },
    upstream_fetch: input.fetch ?? (() => new Response("ok")),
  });
}

describe("interactive HNS community application gateway", () => {
  test("keeps production disabled and rejects every partial or non-exact composition", () => {
    expect(disabledProductionHnsCommunityAppGatewayComposition).toEqual({
      enabled: false,
      service: null,
    });
    expect(makeHnsCommunityAppGatewayComposition(false)).toBe(
      disabledProductionHnsCommunityAppGatewayComposition,
    );
    expect(() => makeHnsCommunityAppGatewayComposition(true)).toThrow(
      "HNS community app gateway composition is incomplete or invalid",
    );
    const valid = {
      profile_bytes: encodeHnsCommunityAppInteractiveGatewayProfileV2(),
      gateway_deployment_reference: deploymentReference,
      solid_origin: "https://solid.example",
      solid_access_client_id: "gateway-access-client-id",
      solid_access_client_secret: "gateway-access-client-secret",
      authority_source: { resolve: () => Effect.succeed(activeState) },
      key_registry: keyRegistry(),
      clock: { nowUnixSeconds: () => now },
      nonce_source: { next: () => "nonce-01" },
      forwarder_limits: {
        max_body_bytes: 1_048_576,
        freshness_window_seconds: 300,
        future_clock_skew_seconds: 5,
      },
      upstream_fetch: () => new Response(),
    };
    const wrongBytes = new Uint8Array(valid.profile_bytes);
    wrongBytes[0] = (wrongBytes[0] ?? 0) ^ 1;
    expect(() =>
      makeHnsCommunityAppGatewayComposition(true, { ...valid, profile_bytes: wrongBytes }),
    ).toThrow("HNS community app gateway composition is incomplete or invalid");
    expect(() =>
      makeHnsCommunityAppGatewayComposition(true, {
        ...valid,
        solid_origin: "http://solid.example",
      }),
    ).toThrow("HNS community app gateway composition is incomplete or invalid");
    expect(() =>
      makeHnsCommunityAppGatewayComposition(true, {
        ...valid,
        forwarder_limits: { ...valid.forwarder_limits, max_body_bytes: 1_048_575 },
      }),
    ).toThrow("HNS community app gateway composition is incomplete or invalid");
  });

  test("maps only the root while preserving other read targets and writes exact v3 fields", async () => {
    const calls: Request[] = [];
    const enabled = composition({
      fetch: (upstream) => {
        calls.push(upstream);
        return new Response("community", {
          headers: {
            "content-type": "text/plain",
            "cf-access-jwt-assertion": "must-not-return",
          },
        });
      },
    });
    if (!enabled.enabled) throw new Error("test composition is disabled");

    const rootResponse = await enabled.service.handle(request({ target: "/?q=%2Bvalue" }));
    const navigationResponse = await enabled.service.handle(
      request({ target: "/auth/sign-in?flow=community%2Blogin" }),
    );
    expect(rootResponse.status).toBe(200);
    expect(await rootResponse.text()).toBe("community");
    expect(rootResponse.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(rootResponse.headers.get("cache-control")).toBe("no-store");
    expect(navigationResponse.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual([
      "https://solid.example/c/xn--pokmon-dva?q=%2Bvalue",
      "https://solid.example/auth/sign-in?flow=community%2Blogin",
    ]);
    expect(calls[0]?.headers.get(HNS_FORWARDER_HOST_HEADER)).toBe(host);
    expect(calls[0]?.headers.get(HNS_FORWARDER_PATH_HEADER)).toBe("/c/xn--pokmon-dva?q=%2Bvalue");
    expect(calls[0]?.headers.get(HNS_FORWARDER_NONCE_HEADER)).toBe("");
    expect(calls[0]?.headers.get("cf-access-client-id")).toBe("gateway-access-client-id");
    expect(calls[0]?.headers.get("cf-access-client-secret")).toBe("gateway-access-client-secret");
    expect(calls[0]?.headers.get(HNS_FORWARDER_SIGNATURE_HEADER)).toMatch(/^v3=[0-9a-f]{64}$/u);
    expect(calls[0]?.redirect).toBe("manual");
  });

  test("forwards one bounded unsafe API body with exact Origin, CSRF, cookies, and nonce", async () => {
    const observations: Array<{ request: Request; body: Uint8Array }> = [];
    const enabled = composition({
      fetch: async (upstream) => {
        observations.push({
          request: upstream,
          body: new Uint8Array(await upstream.arrayBuffer()),
        });
        const headers = new Headers();
        headers.append(
          "set-cookie",
          "__Host-pirate_session=session; HttpOnly; Path=/; Secure; SameSite=Lax; Max-Age=3600",
        );
        headers.append(
          "set-cookie",
          "__Host-pirate_csrf=csrf; Path=/; Secure; SameSite=Lax; Max-Age=3600",
        );
        return new Response('{"status":"ok"}', { headers });
      },
    });
    if (!enabled.enabled) throw new Error("test composition is disabled");
    const body = new TextEncoder().encode('{"proof":"value"}');
    const fields: readonly HnsStaticPlatformGatewayHeaderField[] = [
      ...request().header_fields,
      ["Content-Length", String(body.byteLength)],
      ["Content-Type", "application/json"],
      ["Cookie", "__Host-pirate_session=session; __Host-pirate_csrf=csrf"],
      ["Origin", `https://${host}`],
      ["X-CSRF-Token", "csrf"],
      ["CF-Access-Jwt-Assertion", "client-forgery"],
      ["X-Pirate-Hns-Forwarder-Signature", "client-forgery"],
    ];
    const response = await enabled.service.handle(
      request({
        method: "POST",
        target: "/api/auth/session/exchange?attempt=1",
        header_fields: fields,
        body_bytes: body,
      }),
    );

    expect(response.status).toBe(200);
    expect(observations).toHaveLength(1);
    const observed = observations[0];
    expect(observed?.request.url).toBe("https://solid.example/api/auth/session/exchange?attempt=1");
    expect(observed?.request.method).toBe("POST");
    expect(observed?.request.headers.get("origin")).toBe(`https://${host}`);
    expect(observed?.request.headers.get("x-csrf-token")).toBe("csrf");
    expect(observed?.request.headers.get("cookie")).toBe(
      "__Host-pirate_session=session; __Host-pirate_csrf=csrf",
    );
    expect(observed?.request.headers.get("cf-access-jwt-assertion")).toBeNull();
    expect(observed?.request.headers.get("cf-access-client-id")).toBe("gateway-access-client-id");
    expect(observed?.request.headers.get("cf-access-client-secret")).toBe(
      "gateway-access-client-secret",
    );
    expect(observed?.request.headers.get(HNS_FORWARDER_NONCE_HEADER)).toBe("nonce-01");
    expect(observed?.body).toEqual(body);
    expect(response.headers.getSetCookie()).toHaveLength(2);
  });

  test("rejects platform, unknown, mismatched, and unsafe non-API hosts before upstream", async () => {
    let calls = 0;
    const enabled = composition({
      fetch: () => {
        calls += 1;
        return new Response();
      },
    });
    if (!enabled.enabled) throw new Error("test composition is disabled");
    const withHost = (value: string, overrides: Partial<HnsStaticPlatformGatewayRequest> = {}) =>
      request({
        header_fields: [
          ["Host", value],
          [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
          [HNS_GATEWAY_TLS_SNI_HEADER, value],
        ],
        ...overrides,
      });
    expect((await enabled.service.handle(withHost("app.pirate"))).status).toBe(421);
    expect((await enabled.service.handle(withHost("pirate"))).status).toBe(421);
    expect((await enabled.service.handle(withHost("name.xn--pokmon-dva"))).status).toBe(421);
    expect((await enabled.service.handle(withHost("app.other"))).status).toBe(421);
    expect(
      (
        await enabled.service.handle(
          withHost(host, {
            method: "POST",
            target: "/auth/sign-in",
            header_fields: [...withHost(host).header_fields, ["Origin", `https://${host}`]],
          }),
        )
      ).status,
    ).toBe(405);
    expect(calls).toBe(0);
  });

  test("binds authority to the configured deployment before signing", async () => {
    let calls = 0;
    const enabled = composition({
      current: {
        ...activeState,
        activation_gateway_deployment_reference: "another-deployment",
      },
      fetch: () => {
        calls += 1;
        return new Response();
      },
    });
    if (!enabled.enabled) throw new Error("test composition is disabled");
    expect((await enabled.service.handle(request())).status).toBe(421);
    expect(calls).toBe(0);
  });

  test("enforces request framing, target, and body bounds before signing or fetch", async () => {
    let calls = 0;
    const enabled = composition({
      fetch: () => {
        calls += 1;
        return new Response();
      },
    });
    if (!enabled.enabled) throw new Error("test composition is disabled");
    const post = (body: Uint8Array) =>
      request({
        method: "POST",
        target: "/api/bounded",
        body_bytes: body,
        header_fields: [
          ...request().header_fields,
          ["Content-Length", String(body.byteLength)],
          ["Origin", `https://${host}`],
        ],
      });
    expect((await enabled.service.handle(post(new Uint8Array(1_048_576)))).status).toBe(200);
    expect((await enabled.service.handle(post(new Uint8Array(1_048_577)))).status).toBe(413);
    expect(
      (await enabled.service.handle(request({ method: "GET", body_bytes: new Uint8Array([1]) })))
        .status,
    ).toBe(413);
    expect(
      (
        await enabled.service.handle(
          request({
            header_fields: [...request().header_fields, ["Transfer-Encoding", "chunked"]],
          }),
        )
      ).status,
    ).toBe(413);
    for (const target of [
      "https://evil.invalid/",
      "//evil",
      "/a//b",
      "/a/../b",
      "/a/%2F/b",
      "/a#b",
      "/a\\b",
      "/%zz",
    ]) {
      expect((await enabled.service.handle(request({ target }))).status).toBe(400);
    }
    expect(calls).toBe(1);
  });

  test("performs no retry after one upstream transport failure", async () => {
    let calls = 0;
    const enabled = composition({
      fetch: () => {
        calls += 1;
        throw new Error("unavailable");
      },
    });
    if (!enabled.enabled) throw new Error("test composition is disabled");
    expect((await enabled.service.handle(request())).status).toBe(503);
    expect(calls).toBe(1);
  });

  test("fails weakened cookies, cross-host redirects, and oversized responses closed", async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: `https://${host}/login` } }),
      new Response(null, { status: 302, headers: { location: "https://evil.invalid/login" } }),
      new Response("bad", {
        headers: {
          "set-cookie": "__Host-pirate_session=value; Path=/; Secure; SameSite=Lax",
        },
      }),
      new Response(null, { headers: { "content-length": "16777217" } }),
    ];
    const enabled = composition({ fetch: () => responses.shift() ?? new Response() });
    if (!enabled.enabled) throw new Error("test composition is disabled");
    expect((await enabled.service.handle(request())).status).toBe(302);
    expect((await enabled.service.handle(request())).status).toBe(502);
    expect((await enabled.service.handle(request())).status).toBe(502);
    expect((await enabled.service.handle(request())).status).toBe(502);
  });

  test("retains first-terminal deadline and caller-abort behavior", async () => {
    let fireDeadline: () => void = () => undefined;
    const signer = {
      sign: () => new Promise<never>(() => undefined),
    };
    const service = makeHnsCommunityAppGatewayService({
      signer,
      gateway_deployment_reference: deploymentReference,
      solid_origin: "https://solid.example",
      solid_access_client_id: "gateway-access-client-id",
      solid_access_client_secret: "gateway-access-client-secret",
      upstream_fetch: () => new Response(),
      set_timeout: (callback: () => void) => {
        fireDeadline = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      clear_timeout: () => undefined,
    });

    const callerFirst = new AbortController();
    const callerResult = service.handle(request({ signal: callerFirst.signal }));
    callerFirst.abort();
    fireDeadline();
    await expect(callerResult).rejects.toBeInstanceOf(HnsCommunityAppGatewayCallerAbort);

    const deadlineFirst = new AbortController();
    const deadlineResult = service.handle(request({ signal: deadlineFirst.signal }));
    fireDeadline();
    deadlineFirst.abort();
    expect((await deadlineResult).status).toBe(504);
  });

  test("interrupts the current-authority lookup when the caller disconnects", async () => {
    let interrupted = false;
    const enabled = makeHnsCommunityAppGatewayComposition(true, {
      profile_bytes: encodeHnsCommunityAppInteractiveGatewayProfileV2(),
      gateway_deployment_reference: deploymentReference,
      solid_origin: "https://solid.example",
      solid_access_client_id: "gateway-access-client-id",
      solid_access_client_secret: "gateway-access-client-secret",
      authority_source: {
        resolve: () => Effect.never.pipe(Effect.ensuring(Effect.sync(() => (interrupted = true)))),
      },
      key_registry: keyRegistry(),
      clock: { nowUnixSeconds: () => now },
      nonce_source: { next: () => "nonce-01" },
      forwarder_limits: {
        max_body_bytes: 1_048_576,
        freshness_window_seconds: 300,
        future_clock_skew_seconds: 5,
      },
      upstream_fetch: () => new Response(),
    });
    if (!enabled.enabled) throw new Error("test composition is disabled");
    const caller = new AbortController();
    const response = enabled.service.handle(request({ signal: caller.signal }));
    await Promise.resolve();
    caller.abort();
    await expect(response).rejects.toBeInstanceOf(HnsCommunityAppGatewayCallerAbort);
    await Bun.sleep(0);
    expect(interrupted).toBe(true);
  });

  test("runs only on loopback with a separate health listener and bounded body", async () => {
    let observedBody = "";
    const enabled = composition({
      fetch: async (upstream) => {
        observedBody = await upstream.text();
        return new Response("ok");
      },
    });
    if (!enabled.enabled) throw new Error("test composition is disabled");
    const server = await startHnsCommunityAppGatewayServer({
      composition: enabled,
      gateway_host: "127.0.0.1",
      gateway_port: 0,
      health_host: "127.0.0.1",
      health_port: 0,
      ready: () => true,
    });
    runningServers.push(server);
    expect((await fetch(`http://127.0.0.1:${server.health_address.port}/readyz`)).status).toBe(204);
    const body = '{"ok":true}';
    const response = await fetch(`http://127.0.0.1:${server.gateway_address.port}/api/test`, {
      method: "POST",
      body,
      headers: {
        Host: host,
        Origin: `https://${host}`,
        "Content-Type": "application/json",
        [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER]: "https",
        [HNS_GATEWAY_TLS_SNI_HEADER]: host,
      },
    });
    expect(response.status).toBe(200);
    expect(observedBody).toBe(body);

    await expect(
      startHnsCommunityAppGatewayServer({
        composition: enabled,
        gateway_host: "0.0.0.0",
        gateway_port: 0,
        health_host: "127.0.0.1",
        health_port: 0,
        ready: () => true,
      }),
    ).rejects.toThrow("configuration is incomplete or invalid");
  });
});
