import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  createProductionHttpWorker,
  type HttpWorkerBindings,
  makeProductionIdentityRegistrationRateLimiter,
} from "./composition.ts";

function toPem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const lines = base64.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function bindings(): Promise<HttpWorkerBindings> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  return {
    CONTROL_PLANE: { connectionString: "postgres://test.invalid/api_next" },
    API_NEXT_ENV: "development",
    CORS_ORIGIN: "https://solid.test",
    REGISTRATION_IP_LIMITER: {
      getByName: () => ({ check: async () => ({ allowed: true }) }),
    },
    REGISTRATION_APPLICATION_LIMITER: {
      getByName: () => ({ check: async () => ({ allowed: true }) }),
    },
    PIRATE_APP_JWT_PRIVATE_KEY: toPem(
      "PRIVATE KEY",
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    ),
    PIRATE_APP_JWT_PUBLIC_KEY: toPem(
      "PUBLIC KEY",
      (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
    ),
    PIRATE_APP_JWT_ISSUER: "api-next-session-test",
    PIRATE_APP_JWT_AUDIENCE: "api-next-browser-test",
    PIRATE_APP_JWT_SCOPE: "api-next-browser-session-test",
    PIRATE_APP_JWT_TTL_SECONDS: "3600",
    PRIVY_APP_ID: "privy-test",
    PRIVY_APP_SECRET: "test-only-secret",
    PRIVY_API_URL: "https://auth.privy.test",
    PRIVY_JWKS_URL: "https://auth.privy.test/jwks.json",
    PRIVY_JWT_ISSUER: "privy-test",
    PRIVY_JWT_AUDIENCE: "privy-test",
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.test",
  };
}

describe("HTTP production composition", () => {
  test("requires both Durable Object registration limiter bindings", () => {
    expect(() =>
      makeProductionIdentityRegistrationRateLimiter({} as HttpWorkerBindings, "development"),
    ).toThrow("Registration Durable Object limiter bindings are incomplete");
  });

  test("builds the limiter adapter from both named Durable Object bindings", async () => {
    const calls: string[] = [];
    const binding = {
      getByName: (name: string) => ({
        check: async () => {
          calls.push(name);
          return { allowed: true };
        },
      }),
    };
    const limiter = makeProductionIdentityRegistrationRateLimiter(
      {
        REGISTRATION_IP_LIMITER: binding,
        REGISTRATION_APPLICATION_LIMITER: binding,
      },
      "staging",
    );
    await Effect.runPromise(limiter.checkIp({ ip: "198.51.100.8" }));
    await Effect.runPromise(limiter.checkApplication());
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe("application:api-next:staging");
  });

  test("constructs the real application seams before serving health", async () => {
    const worker = await createProductionHttpWorker(await bindings());
    const response = await worker.request("https://worker.test/health");
    expect(response.status).toBe(200);
    expect((await response.json()) as unknown).toEqual({ status: "ok" });

    const jwks = await worker.request("https://worker.test/.well-known/jwks.json");
    expect(jwks.status).toBe(200);
    // Bounded cache so a future key rotation propagates within the TTL rather
    // than being defeated by unbounded intermediary caching.
    expect(jwks.headers.get("cache-control")).toBe("public, max-age=3600, must-revalidate");
    expect((await jwks.json()) as unknown).toMatchObject({
      keys: [{ alg: "RS256", use: "sig", key_ops: ["verify"] }],
    });

    const registration = await worker.request("https://worker.test/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ privy_access_token: "not-reached" }),
    });
    expect(registration.status).toBe(400);
    expect(await registration.json()).toMatchObject({
      error: { code: "bad_request" },
    });

    const currentUser = await worker.request("https://worker.test/users/me");
    expect(currentUser.status).toBe(401);
    expect(await currentUser.json()).toMatchObject({ error: { code: "auth_error" } });

    const begin = await worker.request("https://worker.test/money/community-purchase-funding", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ quote_id: "quote-a", client_nonce: "nonce-a" }),
    });
    expect(begin.status).toBe(404);

    const quote = await worker.request(
      "https://worker.test/money/community-purchase-funding/quotes",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ community_id: "community-a", listing_id: "listing-a" }),
      },
    );
    // The quote route is installed, but remains protected by the wallet-auth
    // session boundary before it can reach the control-plane producer.
    expect(quote.status).toBe(401);

    for (const fundingRequest of [
      new Request("https://worker.test/money/community-purchase-funding/operation-a"),
      new Request("https://worker.test/money/community-purchase-funding/operation-a/observations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ transaction_hash: `0x${"1".repeat(64)}` }),
      }),
    ]) {
      const fundingResponse = await worker.request(fundingRequest);
      expect(fundingResponse.status).toBe(401);
      expect(await fundingResponse.json()).toMatchObject({ error: { code: "auth_error" } });
    }

    const startVerification = await worker.request("https://worker.test/verification/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intent_id: "intent-1", provider_id: "future.provider" }),
    });
    expect(startVerification.status).toBe(401);

    const callback = await worker.request(
      "https://worker.test/verification/callbacks/future.provider",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: '{\n  "signed": true\n}',
      },
    );
    expect(callback.status).toBe(404);
    const callbackBody = await callback.text();
    expect(JSON.parse(callbackBody)).toMatchObject({ error: { code: "not_found" } });
    expect(callbackBody).not.toContain("future.provider");
  });

  test("fails closed before route construction when a provider setting is absent", async () => {
    const complete = await bindings();
    const { PRIVY_JWT_ISSUER: _omitted, ...incomplete } = complete;
    await expect(createProductionHttpWorker(incomplete)).rejects.toThrow(
      "HTTP worker configuration is incomplete or invalid",
    );
  });

  test("fails closed when registration Durable Object bindings are absent", async () => {
    const complete = await bindings();
    const {
      REGISTRATION_IP_LIMITER: _ip,
      REGISTRATION_APPLICATION_LIMITER: _application,
      ...withoutLimiters
    } = complete;
    await expect(createProductionHttpWorker(withoutLimiters)).rejects.toThrow(
      "Registration Durable Object limiter bindings are incomplete",
    );
  });

  test("rejects non-TLS funding RPC origins outside local development", async () => {
    const configured = await bindings();
    await expect(
      createProductionHttpWorker({
        ...configured,
        API_NEXT_ENV: "staging",
        COMMUNITY_PURCHASE_FUNDING_RPC_URL: "http://rpc.test",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("enables Self only with an explicit public HTTPS origin", async () => {
    const configured = await bindings();
    const worker = await createProductionHttpWorker({
      ...configured,
      SELF_PASS_ENABLED: "true",
      SELF_PASS_MOCK_PASSPORT: "false",
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
    });
    expect((await worker.request("https://worker.test/health")).status).toBe(200);

    await expect(
      createProductionHttpWorker({
        ...configured,
        SELF_PASS_ENABLED: "true",
        PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test/callback",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("forbids Self mock documents in production", async () => {
    const configured = await bindings();
    await expect(
      createProductionHttpWorker({
        ...configured,
        API_NEXT_ENV: "production",
        SELF_PASS_ENABLED: "true",
        SELF_PASS_MOCK_PASSPORT: "true",
        PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.test",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("fails closed on incomplete or reused ZKPassport signing configuration", async () => {
    const configured = await bindings();
    const base = {
      ...configured,
      ZKPASSPORT_ENABLED: "true",
      ZKPASSPORT_DOMAIN: "api.example",
      ZKPASSPORT_NAME: "Pirate",
      ZKPASSPORT_VERIFIER_URL: "https://verifier.example/verify",
      ZKPASSPORT_VERIFIER_SHARED_SECRET: "bearer-secret",
      ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET: "response-secret",
      ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID: "key-2026-08",
    };
    await expect(createProductionHttpWorker(base)).resolves.toBeDefined();
    await expect(
      createProductionHttpWorker({
        ...base,
        ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID: "",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
    await expect(
      createProductionHttpWorker({
        ...base,
        ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_KEY_ID: "bad key id",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
    await expect(
      createProductionHttpWorker({
        ...base,
        ZKPASSPORT_VERIFIER_RESPONSE_SIGNING_SECRET: "bearer-secret",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
    await expect(
      createProductionHttpWorker({
        ...base,
        ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID: "key-2026-07",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
    await expect(
      createProductionHttpWorker({
        ...base,
        ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_KEY_ID: "key-2026-07",
        ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_SECRET: "previous-response-secret",
        ZKPASSPORT_VERIFIER_PREVIOUS_RESPONSE_SIGNING_VALID_UNTIL: "2099-01-01T00:30:00.000Z",
      }),
    ).resolves.toBeDefined();
  });

  test("keeps callback capture staging-only and fail-closed", async () => {
    const configured = await bindings();
    const namespace = {
      idFromName: () => "id",
      get: () => ({ fetch: async () => new Response() }),
    };
    await expect(
      createProductionHttpWorker({
        ...configured,
        SELF_CALLBACK_CAPTURE_ENABLED: "true",
        SELF_CALLBACK_CAPTURE_ACCESS_TOKEN: "capture-token-which-is-long-enough-123456",
        SELF_CALLBACK_CAPTURE: namespace,
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");

    await expect(
      createProductionHttpWorker({
        ...configured,
        API_NEXT_ENV: "staging",
        SELF_PASS_ENABLED: "true",
        PIRATE_API_PUBLIC_ORIGIN: "https://api-next-staging.test",
        SELF_CALLBACK_CAPTURE_ENABLED: "true",
        SELF_CALLBACK_CAPTURE_ACCESS_TOKEN: "too-short",
        SELF_CALLBACK_CAPTURE: namespace,
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });
});
