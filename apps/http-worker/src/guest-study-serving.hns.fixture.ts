// Genuine Worker + actual Access RSA verifier + actual forwarder HMAC/replay.
// Synthetic accepted HNS host state is copied byte-exact from the maintained test.
import { expect } from "bun:test";
import { makeCloudflareAccessJwtValidatorV1 } from "@pirate/platform-cf/cloudflare-access-jwt";
import type { HnsCommunityAppHostAuthorityStateV1 } from "@pirate/platform-cf/hns-community-app-api";
import {
  makeHnsForwarderV3Gateway,
  makeStaticHnsForwarderKeyRegistryV1,
} from "@pirate/platform-cf/hns-forwarder-v3";
import { Effect } from "effect";
import { makeHnsCommunityAppApiComposition } from "./hns-community-app-api-composition.ts";
import type { HttpWorkerOptions } from "./transport.ts";
import { createHttpWorker } from "./transport.ts";

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
export const now = 1_770_000_000;
export const exactOrigin = `https://${activeState.normalized_host}`;
export const protectedOrigin = "https://guest-study-api.internal";
const issuer = "https://owned-study.cloudflareaccess.com";
const audience = "owned-study-audience";
const b64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
const encode = (value: unknown) => b64(new TextEncoder().encode(JSON.stringify(value)));
export async function servingHnsHarness(
  guestStudy?: HttpWorkerOptions["guestStudy"],
  communityId = activeState.community_id,
) {
  const acceptedState = { ...activeState, community_id: communityId };
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const header = encode({ alg: "RS256", kid: "owned-study-key" });
  async function token(expiry = now + 300) {
    const body = encode({ iss: issuer, aud: audience, iat: now, exp: expiry });
    const message = `${header}.${body}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(message),
    );
    return `${message}.${b64(new Uint8Array(signature))}`;
  }
  let keyReads = 0;
  const access = makeCloudflareAccessJwtValidatorV1({
    issuer,
    audience,
    jwksUrl: `${issuer}/cdn-cgi/access/certs`,
    clock: { nowUnixSeconds: () => now },
    fetchImpl: async (url) => {
      expect(String(url)).toBe(`${issuer}/cdn-cgi/access/certs`);
      keyReads++;
      return Response.json(
        { keys: [{ ...jwk, kid: "owned-study-key" }] },
        { headers: { "cache-control": "max-age=300" } },
      );
    },
  });
  const registry = makeStaticHnsForwarderKeyRegistryV1([
    {
      key_id: "owned-forwarder-key",
      key_bytes: crypto.getRandomValues(new Uint8Array(32)),
      signing_enabled: true,
      verify_not_before: now - 300,
      verify_not_after: now + 300,
    },
  ]);
  const clock = { nowUnixSeconds: () => now };
  const limits = {
    max_body_bytes: 1_048_576,
    freshness_window_seconds: 300,
    future_clock_skew_seconds: 5,
  };
  const authority = {
    resolve: (host: string) =>
      Effect.succeed(host === activeState.normalized_host ? acceptedState : null),
  };
  let nonce = 0;
  const gateway = makeHnsForwarderV3Gateway({
    authority_source: authority,
    key_registry: registry,
    clock,
    limits,
    nonce_source: { next: () => `owned-guest-study-${++nonce}` },
  });
  const consumed = new Set<string>();
  const composition = makeHnsCommunityAppApiComposition(true, {
    protected_origin: protectedOrigin,
    access_validator: access,
    authority_source: authority,
    key_registry: registry,
    clock,
    limits,
    replay_store: {
      consume: async (kid, value) => {
        const key = `${kid}:${value}`;
        if (consumed.has(key)) return false;
        consumed.add(key);
        return true;
      },
    },
  });
  const worker = createHttpWorker({
    ...(guestStudy === undefined ? {} : { guestStudy }),
    config: {
      corsOrigin: "https://community.example",
      hnsCommunityAppApiProtectedOrigin: protectedOrigin,
    },
    hnsCommunityAppApi: composition,
  });
  async function signed(
    path: string,
    method: "GET" | "POST" = "GET",
    assertion?: string,
    options: Readonly<{ headers?: Headers; bodyBytes?: Uint8Array; host?: string }> = {},
  ) {
    const headers = new Headers(options.headers);
    if (!headers.has("origin")) headers.set("origin", exactOrigin);
    const bodyBytes = options.bodyBytes ?? new Uint8Array();
    const envelope = await gateway.sign({
      method,
      normalized_host: options.host ?? activeState.normalized_host,
      path_and_query: path,
      headers,
      body_bytes: bodyBytes,
    });
    envelope.headers.set("cf-access-jwt-assertion", assertion ?? (await token()));
    return new Request(`${protectedOrigin}${path}`, {
      method,
      headers: envelope.headers,
      ...(method === "GET" || bodyBytes.byteLength === 0
        ? {}
        : { body: new Uint8Array(bodyBytes) }),
    });
  }
  return { worker, signed, token, exactOrigin, protectedOrigin, keyReads: () => keyReads };
}
