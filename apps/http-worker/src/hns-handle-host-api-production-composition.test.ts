import { describe, expect, test } from "bun:test";
import { HttpWorkerConfig, loadConfigFrom } from "@pirate/platform-cf/config";
import { Effect } from "effect";
import { makeProductionHnsHandleHostApiComposition } from "./hns-handle-host-api-production-composition.ts";

function config(overrides: Readonly<Record<string, string>> = {}) {
  return loadConfigFrom(HttpWorkerConfig, {
    API_NEXT_ENV: "production",
    CORS_ORIGIN: "https://pirate.sc",
    PIRATE_APP_JWT_PRIVATE_KEY: "private",
    PIRATE_APP_JWT_PUBLIC_KEY: "public",
    PIRATE_APP_JWT_ISSUER: "api-next-session-production",
    PIRATE_APP_JWT_AUDIENCE: "api-next-browser-production",
    PIRATE_APP_JWT_SCOPE: "api-next-browser-session-production",
    PRIVY_APP_ID: "privy-production",
    PRIVY_APP_SECRET: "privy-secret",
    PRIVY_JWKS_URL: "https://auth.privy.test/jwks",
    PRIVY_JWT_ISSUER: "privy.io",
    PRIVY_JWT_AUDIENCE: "privy-production",
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.test",
    MEGAPOT_REWARDS_ENABLED: "false",
    MEGAPOT_CHAIN_ID: "8453",
    MEGAPOT_ATTESTATION_ID: "megapot-production-v1",
    MEGAPOT_REQUIRED_CONFIRMATIONS: "3",
    HNS_HANDLE_HOST_API_ENABLED: "true",
    HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: "https://hns-community-api.pirate.sc",
    HNS_COMMUNITY_APP_API_ACCESS_ISSUER: "https://pirate.cloudflareaccess.com",
    HNS_COMMUNITY_APP_API_ACCESS_JWKS_URL:
      "https://pirate.cloudflareaccess.com/cdn-cgi/access/certs",
    HNS_COMMUNITY_APP_API_ACCESS_AUDIENCE: "hns-api-production-aud",
    ...overrides,
  });
}

const authoritySource = { resolve: () => Effect.succeed(null) };

describe("production HNS handle-host API composition", () => {
  test("stays inert before explicit enablement", () => {
    expect(
      makeProductionHnsHandleHostApiComposition({
        config: config({ HNS_HANDLE_HOST_API_ENABLED: "false" }),
        authority_source: authoritySource,
      }),
    ).toEqual({ enabled: false, access_validator: null, authority_source: null });
  });

  test("shares the exact protected API trust boundary and keeps its authority source", () => {
    const composition = makeProductionHnsHandleHostApiComposition({
      config: config(),
      authority_source: authoritySource,
      clock: { nowUnixSeconds: () => 1_770_000_000 },
    });
    expect(composition.enabled).toBe(true);
    if (!composition.enabled) throw new Error("expected enabled composition");
    expect(composition.authority_source).toBe(authoritySource);
  });

  test("rejects a non-exact protected origin", () => {
    expect(() =>
      makeProductionHnsHandleHostApiComposition({
        config: config({
          HNS_COMMUNITY_APP_API_PROTECTED_ORIGIN: "https://hns-community-api.pirate.sc/path",
        }),
        authority_source: authoritySource,
      }),
    ).toThrow("HNS handle-host API production configuration is incomplete or invalid");
  });
});
