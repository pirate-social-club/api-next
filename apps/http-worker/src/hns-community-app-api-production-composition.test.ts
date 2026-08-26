import { describe, expect, test } from "bun:test";
import { HttpWorkerConfig, loadConfigFrom } from "@pirate/platform-cf/config";
import { Effect } from "effect";
import {
  HNS_FORWARDER_V3_KEY_REGISTRY_SCHEMA,
  makeProductionHnsCommunityAppApiComposition,
} from "./hns-community-app-api-production-composition.ts";

const now = 1_770_000_000;
const keyReference = "hns-forwarder-rehearsal";
const keyVersion = "2026-08-26-01";

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function registry(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schema: HNS_FORWARDER_V3_KEY_REGISTRY_SCHEMA,
    registry_reference: keyReference,
    registry_version: keyVersion,
    keys: [
      {
        key_id: "gateway-key-rehearsal",
        key_base64url: base64url(new Uint8Array(32).fill(7)),
        signing_enabled: true,
        verify_not_before: now - 3_600,
        verify_not_after: now + 3_600,
      },
    ],
    ...overrides,
  });
}

function config(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfigFrom(HttpWorkerConfig, {
    API_NEXT_ENV: "staging",
    CORS_ORIGIN: "https://staging.pirate.sc",
    PIRATE_APP_JWT_PRIVATE_KEY: "private",
    PIRATE_APP_JWT_PUBLIC_KEY: "public",
    PIRATE_APP_JWT_ISSUER: "api-next-session-staging",
    PIRATE_APP_JWT_AUDIENCE: "api-next-browser-staging",
    PIRATE_APP_JWT_SCOPE: "api-next-browser-session-staging",
    PRIVY_APP_ID: "privy-staging",
    PRIVY_APP_SECRET: "privy-secret",
    PRIVY_JWKS_URL: "https://auth.privy.test/jwks",
    PRIVY_JWT_ISSUER: "privy.io",
    PRIVY_JWT_AUDIENCE: "privy-staging",
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.test",
    MEGAPOT_REWARDS_ENABLED: "false",
    MEGAPOT_CHAIN_ID: "84532",
    MEGAPOT_V2_RPC_URL: "https://base-sepolia-rpc.test",
    MEGAPOT_ATTESTATION_ID: "megapot-base-sepolia-v2",
    MEGAPOT_REQUIRED_CONFIRMATIONS: "3",
    HNS_COMMUNITY_APP_API_ENABLED: "true",
    HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: "https://hns-api-staging.pirate.sc",
    HNS_COMMUNITY_APP_API_ACCESS_ISSUER: "https://pirate.cloudflareaccess.com",
    HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL:
      "https://pirate.cloudflareaccess.com/cdn-cgi/access/certs",
    HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE: "hns-api-staging-aud",
    HNS_FORWARDER_V3_KEY_REGISTRY_REFERENCE: keyReference,
    HNS_FORWARDER_V3_KEY_REGISTRY_VERSION: keyVersion,
    HNS_FORWARDER_V3_HMAC_KEY_REGISTRY: registry(),
    HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS: "300",
    HNS_FORWARDER_V3_FUTURE_CLOCK_SKEW_SECONDS: "5",
    ...overrides,
  });
}

const authoritySource = { resolve: () => Effect.succeed(null) };
const replayNamespace = {
  getByName: () => ({ consume: async () => true }),
};

describe("production HNS community API composition", () => {
  test("stays inert without any HNS authority when the flag is false", () => {
    const disabled = makeProductionHnsCommunityAppApiComposition({
      config: config({ HNS_COMMUNITY_APP_API_ENABLED: "false" }),
      authority_source: authoritySource,
    });
    expect(disabled).toEqual({
      enabled: false,
      access_validator: null,
      forwarder_validator: null,
      authority_source: null,
      protected_origin: null,
    });
  });

  test("assembles one complete source-closed production graph", () => {
    const composition = makeProductionHnsCommunityAppApiComposition({
      config: config(),
      authority_source: authoritySource,
      replay_namespace: replayNamespace,
      clock: { nowUnixSeconds: () => now },
    });
    expect(composition.enabled).toBe(true);
    if (!composition.enabled) throw new Error("expected enabled composition");
    expect(composition.protected_origin).toBe("https://hns-api-staging.pirate.sc");
    expect(composition.authority_source).toBe(authoritySource);
  });

  test("fails closed for a missing replay binding or mismatched registry identity", () => {
    expect(() =>
      makeProductionHnsCommunityAppApiComposition({
        config: config(),
        authority_source: authoritySource,
        clock: { nowUnixSeconds: () => now },
      }),
    ).toThrow("HNS community API production configuration is incomplete or invalid");

    expect(() =>
      makeProductionHnsCommunityAppApiComposition({
        config: config({ HNS_FORWARDER_V3_KEY_REGISTRY_VERSION: "substituted" }),
        authority_source: authoritySource,
        replay_namespace: replayNamespace,
        clock: { nowUnixSeconds: () => now },
      }),
    ).toThrow("HNS community API production configuration is incomplete or invalid");
  });

  test("rejects alternate ingress origins and non-exact registry documents", () => {
    for (const overrides of [
      { HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: "https://hns-api-staging.pirate.sc/path" },
      { HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: "http://hns-api-staging.pirate.sc" },
      { HNS_FORWARDER_V3_HMAC_KEY_REGISTRY: registry({ unexpected: true }) },
      { HNS_FORWARDER_V3_FRESHNESS_WINDOW_SECONDS: "0" },
    ]) {
      expect(() =>
        makeProductionHnsCommunityAppApiComposition({
          config: config(overrides),
          authority_source: authoritySource,
          replay_namespace: replayNamespace,
          clock: { nowUnixSeconds: () => now },
        }),
      ).toThrow("HNS community API production configuration is incomplete or invalid");
    }
  });
});
