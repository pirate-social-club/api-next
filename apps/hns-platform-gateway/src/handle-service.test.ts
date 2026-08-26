import { describe, expect, test } from "bun:test";
import { encodeHnsCommunityHandlePersonaGatewayProfileV1 } from "@pirate/application/hns-community-handle-gateway";
import type { HnsHandlePersonaHostAuthorityStateV1 } from "@pirate/application/hns-host-serving";
import { makeStaticHnsForwarderKeyRegistryV1 } from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import {
  disabledProductionHnsCommunityHandleGatewayComposition,
  makeHnsCommunityHandleGatewayComposition,
} from "./handle-composition.ts";
import { admitHnsCommunityHandleGatewayRequest } from "./handle-request.ts";
import {
  HnsCommunityHandleGatewayCallerAbort,
  makeHnsCommunityHandleGatewayService,
} from "./handle-service.ts";
import {
  HNS_GATEWAY_EXTERNAL_SCHEME_HEADER,
  HNS_GATEWAY_TLS_SNI_HEADER,
  type HnsStaticPlatformGatewayRequest,
} from "./request.ts";

const now = 1_770_000_000;
const deployment = "gateway-deployment-handle-v1";
const state: HnsHandlePersonaHostAuthorityStateV1 = {
  variant: "handle_persona_v1",
  normalized_host: "name.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  canonical_handle_label: "name",
  community_id: "com_cmt_public_namespace_test",
  sale_namespace_activation_id: "sale_namespace_activation_01",
  sale_namespace_activation_generation: 3,
  sale_namespace_activation_status: "active",
  sale_namespace_dns_zone_id: "dns-zone-handle",
  sale_namespace_dns_zone_generation: 4,
  sale_namespace_gateway_deployment_reference: deployment,
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
  dns_zone: {
    dns_zone_activation_id: "dns-zone-handle",
    dns_zone_activation_generation: 4,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: deployment,
    gateway_certificate_spki_sha256: "a".repeat(64),
    gateway_health: "healthy",
  },
};

const request = (
  overrides: Partial<HnsStaticPlatformGatewayRequest> = {},
): HnsStaticPlatformGatewayRequest => ({
  method: "GET",
  target: "/",
  header_fields: [
    [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
    [HNS_GATEWAY_TLS_SNI_HEADER, state.normalized_host],
    ["Host", state.normalized_host],
  ],
  body_bytes: new Uint8Array(),
  signal: new AbortController().signal,
  ...overrides,
});

const registry = () =>
  makeStaticHnsForwarderKeyRegistryV1([
    {
      key_id: "gateway-key-2026-08",
      key_bytes: new Uint8Array(32).fill(11),
      signing_enabled: true,
      verify_not_before: now - 60,
      verify_not_after: now + 60,
    },
  ]);

const composition = (
  currentState: HnsHandlePersonaHostAuthorityStateV1 | null,
  upstreamFetch: (request: Request) => Promise<Response> | Response,
) =>
  makeHnsCommunityHandleGatewayComposition(true, {
    profile_bytes: encodeHnsCommunityHandlePersonaGatewayProfileV1(),
    gateway_deployment_reference: deployment,
    solid_origin: "https://solid.internal",
    solid_access_client_id: "access-client-id",
    solid_access_client_secret: "access-client-secret",
    authority_source: { resolve: () => Effect.succeed(currentState) },
    key_registry: registry(),
    clock: { nowUnixSeconds: () => now },
    nonce_source: { next: () => "unused-safe-nonce" },
    forwarder_limits: {
      max_body_bytes: 0,
      freshness_window_seconds: 60,
      future_clock_skew_seconds: 5,
    },
    upstream_fetch: upstreamFetch,
  });

describe("HNS community handle-persona gateway", () => {
  test("is disabled by default and rejects partial composition", () => {
    expect(disabledProductionHnsCommunityHandleGatewayComposition).toEqual({
      enabled: false,
      service: null,
    });
    expect(() => makeHnsCommunityHandleGatewayComposition(true)).toThrow(
      "HNS community handle gateway composition is incomplete or invalid",
    );
  });

  test("admits only exact read-only root requests", () => {
    expect(admitHnsCommunityHandleGatewayRequest(request())).toMatchObject({
      method: "GET",
      normalized_host: state.normalized_host,
    });
    const rejected = [
      request({ method: "POST" }),
      request({ target: "/?query=1" }),
      request({ target: "/p/persona_public_01" }),
      request({ body_bytes: new Uint8Array([1]) }),
      request({
        header_fields: [
          [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
          [HNS_GATEWAY_TLS_SNI_HEADER, state.normalized_host],
          ["Host", state.normalized_host],
          ["Host", state.normalized_host],
        ],
      }),
      request({
        header_fields: [
          [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
          [HNS_GATEWAY_TLS_SNI_HEADER, "other.xn--pokmon-dva"],
          ["Host", state.normalized_host],
        ],
      }),
    ];
    for (const candidate of rejected) {
      expect(admitHnsCommunityHandleGatewayRequest(candidate)).toHaveProperty("status");
    }
  });

  test("forwards only the signed root and source-closed Access credentials", async () => {
    let observed: Request | undefined;
    const active = composition(state, (upstream) => {
      observed = upstream;
      return new Response("persona", {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          etag: '"persona-v1"',
          "x-private-upstream": "remove",
        },
      });
    });
    if (!active.enabled) throw new Error("expected enabled composition");
    const response = await active.service.handle(
      request({
        header_fields: [
          [HNS_GATEWAY_EXTERNAL_SCHEME_HEADER, "https"],
          [HNS_GATEWAY_TLS_SNI_HEADER, state.normalized_host],
          ["Host", state.normalized_host],
          ["Cookie", "session=must-not-cross"],
          ["Authorization", "Bearer must-not-cross"],
          ["Origin", "https://must-not-cross.test"],
          ["X-Forwarded-For", "must-not-cross"],
        ],
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("persona");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("etag")).toBe('"persona-v1"');
    expect(response.headers.get("x-private-upstream")).toBeNull();
    expect(observed?.url).toBe("https://solid.internal/");
    expect(observed?.headers.get("cookie")).toBeNull();
    expect(observed?.headers.get("authorization")).toBeNull();
    expect(observed?.headers.get("origin")).toBeNull();
    expect(observed?.headers.get("x-forwarded-for")).toBeNull();
    expect(observed?.headers.get("cf-access-client-id")).toBe("access-client-id");
    expect(observed?.headers.get("cf-access-client-secret")).toBe("access-client-secret");
    expect(observed?.headers.get("x-pirate-hns-forwarder-path")).toBe("/");
    expect(observed?.headers.get("x-pirate-hns-forwarder-nonce")).toBe("");
  });

  test("fails inactive authority and unsafe upstream responses closed", async () => {
    let calls = 0;
    const inactive = composition({ ...state, handle_grant_active: false }, () => {
      calls += 1;
      return new Response("must not run");
    });
    if (!inactive.enabled) throw new Error("expected enabled composition");
    const inactiveResponse = await inactive.service.handle(request());
    expect(inactiveResponse.status).toBe(421);
    expect(calls).toBe(0);

    for (const upstream of [
      { body: "redirect", status: 302, headers: { location: "https://pirate.sc" } },
      { body: "cookie", status: 200, headers: { "set-cookie": "session=secret" } },
      { body: "failure", status: 500, headers: {} },
    ]) {
      const unsafe = composition(
        state,
        () => new Response(upstream.body, { status: upstream.status, headers: upstream.headers }),
      );
      if (!unsafe.enabled) throw new Error("expected enabled composition");
      const response = await unsafe.service.handle(request());
      expect(response.status).toBe(502);
      expect(await response.text()).toBe("");
    }
  });

  test("maps upstream not-found and unavailable without releasing bodies", async () => {
    for (const status of [404, 503] as const) {
      const active = composition(state, () => new Response("private detail", { status }));
      if (!active.enabled) throw new Error("expected enabled composition");
      const response = await active.service.handle(request({ method: "HEAD" }));
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  test("retains first-terminal deadline and caller-abort behavior", async () => {
    let fireDeadline: () => void = () => undefined;
    const service = makeHnsCommunityHandleGatewayService({
      signer: { sign: () => new Promise<never>(() => undefined) },
      gateway_deployment_reference: deployment,
      solid_origin: "https://solid.internal",
      solid_access_client_id: "access-client-id",
      solid_access_client_secret: "access-client-secret",
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
    await expect(callerResult).rejects.toBeInstanceOf(HnsCommunityHandleGatewayCallerAbort);

    const deadlineFirst = new AbortController();
    const deadlineResult = service.handle(request({ signal: deadlineFirst.signal }));
    fireDeadline();
    deadlineFirst.abort();
    expect((await deadlineResult).status).toBe(504);
  });
});
