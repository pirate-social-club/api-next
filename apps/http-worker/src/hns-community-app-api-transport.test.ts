import { describe, expect, test } from "bun:test";
import type { SessionExchangeServices } from "@pirate/application/use-cases/session-exchange";
import type { HnsCommunityAppHostAuthorityStateV1 } from "@pirate/platform-cf/hns-community-app-api";
import {
  makeHnsForwarderV3Gateway,
  makeStaticHnsForwarderKeyRegistryV1,
} from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import { makeHnsCommunityAppApiComposition } from "./hns-community-app-api-composition.ts";
import { stripHnsCommunityAppPrivateHeaders } from "./hns-community-app-api-transport.ts";
import { createHttpWorker } from "./transport.ts";

const now = 1_770_000_000;
const origin = "https://app.xn--pokmon-dva";
const secret = new TextEncoder().encode("test-forwarder-hmac-key-with-32-bytes");
const limits = {
  max_body_bytes: 1_048_576,
  freshness_window_seconds: 300,
  future_clock_skew_seconds: 5,
};
const activeState: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: "app.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  community_id: "community-public-01",
  app_host_activation_id: "activation-01",
  app_host_activation_generation: 3,
  app_host_activation_status: "active",
  activation_dns_zone_id: "dns-zone-01",
  activation_dns_zone_generation: 2,
  activation_gateway_deployment_reference: "gateway-deployment-01",
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
    gateway_deployment_reference: "gateway-deployment-01",
    gateway_certificate_spki_sha256: "a".repeat(64),
    gateway_health: "healthy",
  },
};

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

const sessionServices: SessionExchangeServices = {
  proofVerifier: {
    verifyPrivy: () =>
      Effect.succeed({ sourceUserId: "same-privy-subject", classification: "user" }),
  },
  identityStore: {
    resolve: () =>
      Effect.succeed({
        canonicalUserId: "same-pirate-account",
        user: {
          id: "same-pirate-account",
          object: "user",
          verification_state: "unverified",
          verification_capabilities: {
            unique_human: { state: "unverified" },
            age_over_18: { state: "unverified" },
            minimum_age: { state: "unverified" },
            nationality: { state: "unverified" },
            gender: { state: "unverified" },
            wallet_score: { state: "unverified" },
          },
          created: 1_700_000_000,
        },
        profile: {
          id: "same-pirate-account",
          object: "profile",
          global_handle: {
            id: "handle-1",
            object: "global_handle",
            label: "captain",
            tier: "generated",
            status: "active",
            issuance_source: "generated_signup",
            issued_at: 1_700_000_000,
          },
          created: 1_700_000_000,
        },
        onboarding: {
          generated_handle_assigned: true,
          cleanup_rename_available: false,
          unique_human_verification_status: "not_started",
          namespace_verification_status: "not_started",
          community_creation_ready: false,
          missing_requirements: [],
          reddit_verification_status: "not_started",
          reddit_import_status: "not_started",
        },
        wallet_attachments: [
          {
            wallet_attachment: "embedded",
            chain_namespace: "eip155",
            wallet_address: "0x0000000000000000000000000000000000000001",
            is_primary: true,
          },
        ],
      }),
  },
  productReadiness: { isReady: () => Effect.succeed(true) },
  tokenMinter: {
    scope: "api-next-browser-session-test",
    mint: ({ subject }) => Effect.succeed(`token-for-${subject}`),
  },
};

function harness() {
  let current: HnsCommunityAppHostAuthorityStateV1 | null = activeState;
  let nonce = 0;
  const consumed = new Set<string>();
  const authoritySource = {
    resolve: (host: string) => Effect.succeed(current?.normalized_host === host ? current : null),
  };
  const gateway = makeHnsForwarderV3Gateway({
    authority_source: authoritySource,
    key_registry: keyRegistry(),
    clock: { nowUnixSeconds: () => now },
    nonce_source: { next: () => `nonce-${++nonce}` },
    limits,
  });
  const composition = makeHnsCommunityAppApiComposition(true, {
    protected_origin: "https://api-next.internal",
    access_validator: {
      verify: async (jwt) => {
        if (jwt !== "access-ok") throw new Error("denied");
      },
    },
    authority_source: authoritySource,
    key_registry: keyRegistry(),
    replay_store: {
      consume: async (keyId, value) => {
        const identity = `${keyId}:${value}`;
        if (consumed.has(identity)) return false;
        consumed.add(identity);
        return true;
      },
    },
    clock: { nowUnixSeconds: () => now },
    limits,
  });
  const worker = createHttpWorker({
    config: { corsOrigin: "https://pirate.sc" },
    sessionExchange: sessionServices,
    hnsCommunityAppApi: composition,
  });

  const signed = async (
    path: string,
    method: "GET" | "POST" | "PATCH",
    bodyText = "",
    requestOrigin = origin,
  ) => {
    const bytes = new TextEncoder().encode(bodyText);
    const headers = new Headers({ origin: requestOrigin });
    if (bodyText !== "") headers.set("content-type", "application/json");
    const envelope = await gateway.sign({
      method,
      normalized_host: activeState.normalized_host,
      path_and_query: path,
      headers,
      body_bytes: bytes,
    });
    envelope.headers.set("cf-access-jwt-assertion", "access-ok");
    return {
      url: `https://api-next.internal${path}`,
      init: {
        method,
        headers: envelope.headers,
        ...(bodyText === "" ? {} : { body: bodyText }),
      },
    };
  };

  return {
    worker,
    signed,
    setCurrent: (next: HnsCommunityAppHostAuthorityStateV1 | null) => {
      current = next;
    },
  };
}

describe("interactive HNS community API transport", () => {
  test("keeps ordinary CORS static and dynamically admits only a verified host", async () => {
    const { worker, signed } = harness();
    const acceptedRequest = await signed("/api/health", "GET");
    const accepted = await worker.request(acceptedRequest.url, acceptedRequest.init);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("access-control-allow-origin")).toBe(origin);

    const preview = await worker.request(
      "https://pirate-http-worker-preview.workers.dev/api/health",
      acceptedRequest.init,
    );
    expect(preview.status).toBe(401);

    const ordinary = await worker.request("https://api-next.internal/health", {
      headers: { origin },
    });
    expect(ordinary.status).toBe(200);
    expect(ordinary.headers.get("access-control-allow-origin")).toBeNull();
    expect(
      (
        await worker.request("https://api-next.internal/health", {
          headers: { "cf-access-jwt-assertion": "access-ok" },
        })
      ).status,
    ).toBe(401);
  });

  test("maps the same Privy subject to the same account and wallet on both origins", async () => {
    const { worker, signed } = harness();
    const body = JSON.stringify({
      proof: { type: "privy_access_token", privy_access_token: "same-proof" },
    });
    const canonical = await worker.request("https://api-next.internal/auth/session/exchange", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://pirate.sc" },
      body,
    });
    const hnsRequest = await signed("/api/auth/session/exchange", "POST", body);
    const hns = await worker.request(hnsRequest.url, hnsRequest.init);
    expect(canonical.status).toBe(200);
    expect(hns.status).toBe(200);
    expect(await hns.json()).toEqual(await canonical.json());
    expect(hns.headers.get("set-cookie")).toContain(
      "__Host-pirate_session=token-for-same-pirate-account; HttpOnly; Path=/; Secure; SameSite=Lax",
    );
    expect(hns.headers.get("set-cookie")).not.toContain("Domain=");
  });

  test("rejects missing Access, wrong Origin, replay, and current authority drift", async () => {
    const { worker, signed, setCurrent } = harness();
    const missingAccess = await signed("/api/auth/session/logout", "POST");
    missingAccess.init.headers.delete("cf-access-jwt-assertion");
    expect((await worker.request(missingAccess.url, missingAccess.init)).status).toBe(401);

    const wrongOrigin = await signed(
      "/api/auth/session/logout",
      "POST",
      "",
      "https://app.attacker",
    );
    expect((await worker.request(wrongOrigin.url, wrongOrigin.init)).status).toBe(401);

    const replayed = await signed("/api/auth/session/logout", "POST");
    expect((await worker.request(replayed.url, replayed.init)).status).toBe(200);
    expect((await worker.request(replayed.url, replayed.init)).status).toBe(400);

    const stale = await signed("/api/health", "GET");
    setCurrent({ ...activeState, route_authority_generation: 8 });
    expect((await worker.request(stale.url, stale.init)).status).toBe(400);
  });

  test("serves the exact private v2 authority capability after Access authentication", async () => {
    const { worker, setCurrent } = harness();
    const authority = [
      "community_app_v1",
      ["activation-01", 3],
      "route-binding-01",
      ["operator_managed_route_v1", "operator-activation-01", 7],
    ];
    const body = JSON.stringify([
      "pirate-hns-solid-host-authority-request-v2",
      "app.xn--pokmon-dva",
      authority,
      "gateway-deployment-01",
    ]);
    const response = await worker.request(
      "https://api-next.internal/internal/hns/solid-host-authority/v2/resolve",
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "cf-access-jwt-assertion": "access-ok",
        },
        body,
      },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(
      JSON.stringify([
        "pirate-hns-solid-host-authority-response-v2",
        "active",
        "app.xn--pokmon-dva",
        "xn--pokmon-dva",
        "community-public-01",
        authority,
        "gateway-deployment-01",
      ]),
    );

    expect(
      (
        await worker.request(
          "https://api-next.internal/internal/hns/solid-host-authority/v2/resolve",
          {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: `${body}\n`,
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.request(
          "https://pirate-http-worker-preview.workers.dev/internal/hns/solid-host-authority/v2/resolve",
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "cf-access-jwt-assertion": "access-ok",
            },
            body,
          },
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await worker.request(
          "https://api-next.internal/internal/hns/solid-host-authority/v2/resolve",
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "cf-access-jwt-assertion": "access-ok",
            },
            body: `${body}\n`,
          },
        )
      ).status,
    ).toBe(400);
    setCurrent({ ...activeState, app_host_activation_status: "suspended" });
    expect(
      (
        await worker.request(
          "https://api-next.internal/internal/hns/solid-host-authority/v2/resolve",
          {
            method: "POST",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
              "cf-access-jwt-assertion": "access-ok",
            },
            body,
          },
        )
      ).status,
    ).toBe(404);
  });

  test("removes every private authority header before product-visible decoding", () => {
    const stripped = stripHnsCommunityAppPrivateHeaders(
      new Headers({
        "cf-access-jwt-assertion": "secret",
        "cf-access-client-id": "client-id",
        "x-pirate-hns-forwarder-signature": "signature",
        "x-pirate-gateway-private": "private",
        origin,
        "idempotency-key": "retained",
      }),
    );
    expect(Object.fromEntries(stripped)).toEqual({
      origin,
      "idempotency-key": "retained",
    });
  });
});
