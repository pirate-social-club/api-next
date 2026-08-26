/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:test";
import { makeCloudflareAccessJwtValidatorV1 } from "@pirate/platform-cf/cloudflare-access-jwt";
import type { HnsCommunityAppHostAuthorityStateV1 } from "@pirate/platform-cf/hns-community-app-api";
import {
  makeHnsForwarderV3Gateway,
  makeStaticHnsForwarderKeyRegistryV1,
} from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  disabledProductionHnsCommunityAppApiComposition,
  makeHnsCommunityAppApiComposition,
} from "../../apps/http-worker/src/hns-community-app-api-composition.ts";
import { createHttpWorker } from "../../apps/http-worker/src/transport.ts";

const now = 1_770_000_000;
const issuer = "https://pirate-workerd.cloudflareaccess.com";
const audience = "access-audience-workerd";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function signedJwt(pair: CryptoKeyPair, kid: string): Promise<string> {
  const encoder = new TextEncoder();
  const header = base64url(encoder.encode(JSON.stringify({ alg: "RS256", kid })));
  const claims = base64url(
    encoder.encode(JSON.stringify({ iss: issuer, aud: audience, iat: now - 1, exp: now + 300 })),
  );
  const input = `${header}.${claims}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    pair.privateKey,
    encoder.encode(input),
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

const state: HnsCommunityAppHostAuthorityStateV1 = {
  variant: "community_app_v1",
  normalized_host: "app.xn--pokmon-dva",
  canonical_root: "xn--pokmon-dva",
  community_id: "community-workerd",
  app_host_activation_id: "activation-workerd",
  app_host_activation_generation: 3,
  app_host_activation_status: "active",
  activation_dns_zone_id: "dns-workerd",
  activation_dns_zone_generation: 2,
  activation_gateway_deployment_reference: "deployment-workerd",
  route_binding_id: "route-workerd",
  route_binding_current: true,
  route_authority_kind: "operator_managed_route_v1",
  route_authority_reference: "operator-workerd",
  route_authority_generation: 7,
  route_authority_effective: true,
  dns_zone: {
    dns_zone_activation_id: "dns-workerd",
    dns_zone_activation_generation: 2,
    status: "active",
    stable_chain_delegation_matches: true,
    dnssec_ds_authenticates_zone: true,
    retained_zone_digest_matches: true,
    gateway_deployment_reference: "deployment-workerd",
    gateway_certificate_spki_sha256: "a".repeat(64),
    gateway_health: "healthy",
  },
};

describe("interactive HNS API trust boundary in Workerd", () => {
  it("validates Access RS256 and accepts one unknown-kid rotation refetch", async () => {
    const generate = () =>
      crypto.subtle.generateKey(
        {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2_048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        },
        true,
        ["sign", "verify"],
      ) as Promise<CryptoKeyPair>;
    const [oldPair, rotatedPair] = await Promise.all([generate(), generate()]);
    const oldJwk = { ...(await crypto.subtle.exportKey("jwk", oldPair.publicKey)), kid: "old" };
    const rotatedJwk = {
      ...(await crypto.subtle.exportKey("jwk", rotatedPair.publicKey)),
      kid: "rotated",
    };
    let calls = 0;
    const validator = makeCloudflareAccessJwtValidatorV1({
      issuer,
      audience,
      jwksUrl: `${issuer}/cdn-cgi/access/certs`,
      clock: { nowUnixSeconds: () => now },
      fetchImpl: async () => {
        calls += 1;
        return Response.json({ keys: [calls === 1 ? oldJwk : rotatedJwk] });
      },
    });
    await validator.verify(await signedJwt(oldPair, "old"));
    await validator.verify(await signedJwt(rotatedPair, "rotated"));
    expect(calls).toBe(2);
  });

  it("verifies a signed alias before exposing the ordinary health handler", async () => {
    const secret = new TextEncoder().encode("test-forwarder-hmac-key-with-32-bytes");
    const registry = makeStaticHnsForwarderKeyRegistryV1([
      {
        key_id: "gateway-key-workerd",
        key_bytes: secret,
        signing_enabled: true,
        verify_not_before: now - 60,
        verify_not_after: now + 60,
      },
    ]);
    const source = { resolve: () => Effect.succeed(state) };
    const limits = {
      max_body_bytes: 1_048_576,
      freshness_window_seconds: 30,
      future_clock_skew_seconds: 1,
    };
    const gateway = makeHnsForwarderV3Gateway({
      authority_source: source,
      key_registry: registry,
      clock: { nowUnixSeconds: () => now },
      nonce_source: { next: () => "nonce-workerd" },
      limits,
    });
    const envelope = await gateway.sign({
      method: "GET",
      normalized_host: state.normalized_host,
      path_and_query: "/api/health",
      headers: new Headers({ origin: `https://${state.normalized_host}` }),
      body_bytes: new Uint8Array(),
    });
    envelope.headers.set("cf-access-jwt-assertion", "access-workerd");
    const worker = createHttpWorker({
      config: { corsOrigin: "https://pirate.sc" },
      hnsCommunityAppApi: makeHnsCommunityAppApiComposition(true, {
        protected_origin: "https://worker.internal",
        access_validator: {
          verify: async (value) => {
            if (value !== "access-workerd") throw new Error("denied");
          },
        },
        authority_source: source,
        key_registry: registry,
        replay_store: { consume: async () => true },
        clock: { nowUnixSeconds: () => now },
        limits,
      }),
    });
    const response = await worker.request("https://worker.internal/api/health", {
      headers: envelope.headers,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      `https://${state.normalized_host}`,
    );
  });

  it("keeps exported production composition disabled with no authority bindings", () => {
    expect(disabledProductionHnsCommunityAppApiComposition).toEqual({
      enabled: false,
      access_validator: null,
      forwarder_validator: null,
      authority_source: null,
      protected_origin: null,
    });
    const bindings = env as unknown as Record<string, unknown>;
    expect("HNS_COMMUNITY_APP_API_ENABLED" in bindings).toBe(false);
    expect("HNS_FORWARDER_KEY_REGISTRY" in bindings).toBe(false);
    expect("HNS_ACCESS_AUDIENCE" in bindings).toBe(false);
  });
});
