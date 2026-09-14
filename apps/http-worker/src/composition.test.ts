import { describe, expect, mock, test } from "bun:test";
import type { HnsOwnerTransport } from "@pirate/platform-cf/namespace-ownership-provider-registry";
import { makeHyperdriveControlPlaneLayer } from "@pirate/platform-cf/postgres";
import { Effect } from "effect";
import { createMediaSubmissionState } from "../../../packages/domain/src/media-submission.ts";
import { makeHttpWorkerTestBindings as bindings } from "./composition.test-fixtures.ts";
import type { HttpWorkerBindings } from "./composition.ts";

// The unit suite must resolve this file's Durable Object imports without a
// sibling test registering the process-global mock first; the composition
// module is imported only after the mock is registered.
mock.module("cloudflare:workers", () => ({
  DurableObject: class DurableObject {},
}));

const {
  createProductionHttpWorker,
  makeProductionIdentityRegistrationRateLimiter,
  makeProductionMediaSubmissionServices,
} = await import("./composition.ts");

function withVeryOauth(bindings: HttpWorkerBindings): HttpWorkerBindings {
  return {
    ...bindings,
    VERY_OAUTH_ENABLED: "true",
    VERY_OAUTH_AUTHORIZATION_ENDPOINT: "https://connect.very.org/oauth/authorize",
    VERY_OAUTH_TOKEN_ENDPOINT: "https://api.very.org/oauth2/token",
    VERY_OAUTH_USERINFO_ENDPOINT: "https://api.very.org/oauth2/userinfo",
    VERY_OAUTH_ISSUER: "https://connect.very.org",
    VERY_OAUTH_JWKS_URL: "https://connect.very.org/.well-known/jwks.json",
    VERY_OAUTH_CLIENT_ID: "pirate-client",
    VERY_OAUTH_CLIENT_SECRET: "client-secret",
    VERY_OAUTH_REDIRECT_URI: "https://api.pirate.test/verification/very/callback",
    VERY_OAUTH_SEALING_KEY: "k".repeat(32),
  };
}

function withVeryWeb(bindings: HttpWorkerBindings): HttpWorkerBindings {
  return {
    ...bindings,
    VERY_WEB_ENABLED: "true",
    VERY_WEB_APP_ID: "pirate-web-staging",
    VERY_WEB_API_URL: "https://api.very.org/api/v1",
    VERY_WEB_VERIFY_URL: "https://verify.very.org/api/v1/verify",
    VERY_WEB_BRIDGE_API_URL: "https://bridge.very.org/api/v1",
    VERY_WEB_SEALING_KEY: "w".repeat(32),
  };
}

const inertHnsTransport: HnsOwnerTransport = {
  start: () => Effect.die("HNS transport must not run during Worker composition"),
  poll: () => Effect.die("HNS transport must not run during Worker composition"),
};

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

    const hnsAlias = await worker.request("https://worker.test/api/health", {
      headers: { "cf-access-jwt-assertion": "not-authority" },
    });
    expect(hnsAlias.status).toBe(401);

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

    for (const namespaceRequest of [
      new Request(
        "https://worker.test/community-creation-intents/intent-1/namespace-ownership/start",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ceremony_intent_id: "ceremony-1",
            expected_revision: 1,
            idempotency_key: "start-1",
          }),
        },
      ),
      new Request(
        "https://worker.test/community-creation-intents/intent-1/namespace-ownership/poll",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ceremony_intent_id: "ceremony-1",
            session_id: "namespace-session-1",
            expected_revision: 1,
            idempotency_key: "poll-1",
            channel: "poll_result",
          }),
        },
      ),
    ]) {
      const namespaceResponse = await worker.request(namespaceRequest);
      // A 401, rather than the transport's 404 for a missing handler, proves
      // both frozen routes are installed behind the session boundary.
      expect(namespaceResponse.status).toBe(401);
      expect(await namespaceResponse.json()).toMatchObject({ error: { code: "auth_error" } });
    }

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

  test("keeps media inert by default and mounts it only from complete fixed bindings", async () => {
    const configured = await bindings();
    await expect(
      createProductionHttpWorker({ ...configured, MEDIA_UPLOADS_ENABLED: "true" }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");

    const worker = await createProductionHttpWorker({
      ...configured,
      MEDIA_UPLOADS_ENABLED: "true",
      MEDIA_INGRESS_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
      MEDIA_INGRESS_R2_BUCKET_NAME: "pirate-media-ingress-staging",
      MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID: "test-access-key",
      MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY: "test-secret-key",
      MEDIA_INGRESS: {
        head: async () => null,
        get: async () => null,
      },
      MEDIA_IMMUTABLE_ORIGINALS: {
        head: async () => null,
        put: async () => null,
      },
    });
    const response = await worker.request(
      "https://worker.test/communities/community-1/media-upload-reservations",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://solid.test" },
        body: "{}",
      },
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "auth_error" } });
    // The song-video interval preflight is mounted with the other media routes:
    // it asks for authentication rather than answering not found.
    const preflight = await worker.request(
      "https://worker.test/communities/community-1/song-video-interval-preflights",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://solid.test" },
        body: "{}",
      },
    );
    expect(preflight.status).toBe(401);
    expect(await preflight.json()).toMatchObject({ error: { code: "auth_error" } });
  });

  test("default media composition constructs a real reference resolver without a test override", async () => {
    const configured = await bindings();
    const runtime = makeHyperdriveControlPlaneLayer({
      connectionString: "postgres://test.invalid/reference-composition",
    });
    const personaStore = { findOwned: () => Effect.succeed(null) };
    expect(makeProductionMediaSubmissionServices(configured, runtime, personaStore)).toBeNull();
    const services = makeProductionMediaSubmissionServices(
      {
        ...configured,
        MEDIA_UPLOADS_ENABLED: "true",
        MEDIA_INGRESS_R2_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
        MEDIA_INGRESS_R2_BUCKET_NAME: "fixture",
        MEDIA_INGRESS_R2_PRESIGN_ACCESS_KEY_ID: "fixture",
        MEDIA_INGRESS_R2_PRESIGN_SECRET_ACCESS_KEY: "fixture",
        MEDIA_INGRESS: { head: async () => null, get: async () => null },
        MEDIA_IMMUTABLE_ORIGINALS: { head: async () => null, put: async () => null },
      },
      runtime,
      personaStore,
    );
    if (services?.referenceResolver === undefined) throw new Error("production resolver missing");
    const submission = createMediaSubmissionState({
      event: "submission_reserved",
      actorId: "account",
      personaId: "persona",
      expectedCreationRevision: 0,
      submissionId: "submission",
      operationId: "operation",
      communityId: "community",
      title: "Fixture",
      songType: "original",
      reservationId: "reservation",
    });
    await expect(
      services.referenceResolver.resolve({
        actorUserId: "account",
        submission,
        referenceRequestRef: "request",
        upstreamAssetId: "source",
      }),
    ).rejects.toMatchObject({ details: { reason_code: "reference_request_invalid" } });
  });

  test("fails closed before route construction when a provider setting is absent", async () => {
    const complete = await bindings();
    const { PRIVY_JWT_ISSUER: _omitted, ...incomplete } = complete;
    await expect(createProductionHttpWorker(incomplete)).rejects.toThrow(
      "HTTP worker configuration is incomplete or invalid",
    );
  });

  test("requires the Megapot RPC only while rewards are enabled", async () => {
    const complete = await bindings();
    const { MEGAPOT_V2_RPC_URL: _omitted, ...withoutMegapotRpc } = complete;
    const disabled = await createProductionHttpWorker(withoutMegapotRpc);
    expect((await disabled.request("https://worker.test/health")).status).toBe(200);

    await expect(
      createProductionHttpWorker({
        ...withoutMegapotRpc,
        MEGAPOT_REWARDS_ENABLED: "true",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("keeps Very OAuth disabled by default and fails closed when enabled incompletely", async () => {
    const configured = await bindings();
    const worker = await createProductionHttpWorker(configured);
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
    await expect(
      createProductionHttpWorker({ ...configured, VERY_OAUTH_ENABLED: "true" }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("constructs the enabled Very OAuth provider without making an upstream request", async () => {
    const configured = await bindings();
    const worker = await createProductionHttpWorker(withVeryOauth(configured));
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
  });

  test("fails closed before registering Very web when required configuration is incomplete", async () => {
    const configured = withVeryWeb(await bindings());
    for (const setting of [
      "VERY_WEB_APP_ID",
      "VERY_WEB_API_URL",
      "VERY_WEB_VERIFY_URL",
      "VERY_WEB_BRIDGE_API_URL",
      "VERY_WEB_SEALING_KEY",
    ] as const) {
      await expect(
        createProductionHttpWorker({ ...configured, [setting]: undefined }),
      ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
    }
  });

  test("constructs the enabled Very web provider without making an upstream request", async () => {
    const worker = await createProductionHttpWorker(withVeryWeb(await bindings()));
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
  });

  test("keeps HNS ownership disabled by default and fails closed when enabled incompletely", async () => {
    const configured = await bindings();
    const worker = await createProductionHttpWorker(configured, {
      hns_ownership: { transport: inertHnsTransport },
    });
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
    await expect(
      createProductionHttpWorker({ ...configured, HNS_OWNERSHIP_ENABLED: "true" }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("constructs enabled HNS ownership without invoking its injected transport", async () => {
    const configured = await bindings();
    const worker = await createProductionHttpWorker(
      {
        ...configured,
        HNS_OWNERSHIP_ENABLED: "true",
        HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "hns-owner-development",
        HNS_OWNERSHIP_CONFIGURATION_VERSION: "hns-owner-config-v1",
      },
      { hns_ownership: { transport: inertHnsTransport } },
    );
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
  });

  test("constructs enabled HNS ownership from only the private service binding", async () => {
    const configured = await bindings();
    let calls = 0;
    const worker = await createProductionHttpWorker({
      ...configured,
      HNS_OWNERSHIP_ENABLED: "true",
      HNS_OWNERSHIP_CONFIGURATION_REFERENCE: "hns-owner-development",
      HNS_OWNERSHIP_CONFIGURATION_VERSION: "hns-owner-config-v1",
      HNS_OWNER_VERIFIER: {
        fetch: async () => {
          calls += 1;
          throw new Error("service binding must not run during composition");
        },
      },
    });
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
    expect(calls).toBe(0);
  });

  test("keeps the activation current-view gatherer disabled by default and fails closed when enabled incompletely", async () => {
    const configured = await bindings();
    const worker = await createProductionHttpWorker(configured);
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
    await expect(
      createProductionHttpWorker({
        ...configured,
        HNS_ACTIVATION_CURRENT_VIEW_ENABLED: "true",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
    await expect(
      createProductionHttpWorker({
        ...configured,
        HNS_ACTIVATION_CURRENT_VIEW_ENABLED: "true",
        HNS_AUTHORITY_HSD_RPC_URL: "https://hsd.example/rpc",
        HNS_AUTHORITY_HSD_AUTHORIZATION: "Basic hunter2",
        HNS_AUTHORITY_CHAIN_NETWORK: "main",
        HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH: `${"0".repeat(63)}1`,
        HNS_AUTHORITY_TREE_INTERVAL_BLOCKS: "36",
        HNS_AUTHORITY_SAFE_CONFIRMATIONS: "12",
        HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS: "600",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("constructs the complete activation current-view gatherer without an upstream request", async () => {
    const configured = await bindings();
    const worker = await createProductionHttpWorker({
      ...configured,
      HNS_ACTIVATION_CURRENT_VIEW_ENABLED: "true",
      HNS_AUTHORITY_HSD_RPC_URL: "https://hsd.example/rpc",
      HNS_AUTHORITY_HSD_AUTHORIZATION: "Basic hunter2",
      HNS_AUTHORITY_CHAIN_NETWORK: "main",
      HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH: `${"0".repeat(63)}1`,
      HNS_AUTHORITY_TREE_INTERVAL_BLOCKS: "36",
      HNS_AUTHORITY_SAFE_CONFIRMATIONS: "12",
      HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS: "600",
      HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS: "60",
    });
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
  });

  test("rejects a forwarded but out-of-range activation observer setting", async () => {
    const configured = await bindings();
    await expect(
      createProductionHttpWorker({
        ...configured,
        HNS_ACTIVATION_CURRENT_VIEW_ENABLED: "true",
        HNS_AUTHORITY_HSD_RPC_URL: "https://hsd.example/rpc",
        HNS_AUTHORITY_HSD_AUTHORIZATION: "Basic hunter2",
        HNS_AUTHORITY_CHAIN_NETWORK: "main",
        HNS_AUTHORITY_CHAIN_GENESIS_BLOCK_HASH: `${"0".repeat(63)}1`,
        HNS_AUTHORITY_TREE_INTERVAL_BLOCKS: "0",
        HNS_AUTHORITY_SAFE_CONFIRMATIONS: "12",
        HNS_AUTHORITY_MAXIMUM_TIP_AGE_SECONDS: "600",
        HNS_AUTHORITY_MAXIMUM_FUTURE_TIP_SECONDS: "60",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("rejects whitespace-padded Very OAuth credentials before provider composition", async () => {
    const configured = await bindings();
    await expect(
      createProductionHttpWorker({
        ...withVeryOauth(configured),
        VERY_OAUTH_CLIENT_SECRET: " client-secret",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
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

  test("keeps OpenAI moderation disabled by default and rejects incomplete enablement", async () => {
    const configured = await bindings();
    await expect(createProductionHttpWorker(configured)).resolves.toBeDefined();
    await expect(
      createProductionHttpWorker({
        ...configured,
        OPENAI_MODERATION_ENABLED: "true",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
    await expect(
      createProductionHttpWorker({
        ...configured,
        OPENAI_MODERATION_MODEL: "omni-moderation-latest",
      }),
    ).rejects.toThrow("HTTP worker configuration is incomplete or invalid");
  });

  test("constructs the pinned OpenAI driver without making a provider request", async () => {
    const configured = await bindings();
    let calls = 0;
    const worker = await createProductionHttpWorker(
      {
        ...configured,
        OPENAI_MODERATION_ENABLED: "true",
        OPENAI_API_KEY: "test-openai-key",
        OPENAI_MODERATION_MODEL: "omni-moderation-2024-09-26",
        OPENAI_MODERATION_BASE_URL: "https://api.openai.com/v1",
        OPENAI_MODERATION_TIMEOUT_MS: "10000",
      },
      {
        openai_moderation_transport: async () => {
          calls += 1;
          throw new Error("provider transport must stay idle during composition");
        },
      },
    );
    expect((await worker.request("https://worker.test/health")).status).toBe(200);
    expect(calls).toBe(0);
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
});
