import { describe, expect, test } from "bun:test";
import { createProductionHttpWorker, type HttpWorkerBindings } from "./composition.ts";

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
    PIRATE_APP_JWT_PRIVATE_KEY: toPem(
      "PRIVATE KEY",
      (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer,
    ),
    PIRATE_APP_JWT_PUBLIC_KEY: toPem(
      "PUBLIC KEY",
      (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer,
    ),
    PIRATE_APP_JWT_ISSUER: "pirate-api",
    PIRATE_APP_JWT_AUDIENCE: "pirate-app",
    PIRATE_APP_JWT_TTL_SECONDS: "3600",
    PRIVY_APP_ID: "privy-test",
    PRIVY_APP_SECRET: "test-only-secret",
    PRIVY_API_URL: "https://auth.privy.test",
    PRIVY_JWKS_URL: "https://auth.privy.test/jwks.json",
    PRIVY_JWT_ISSUER: "privy-test",
    PRIVY_JWT_AUDIENCE: "privy-test",
  };
}

describe("HTTP production composition", () => {
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

    const currentUser = await worker.request("https://worker.test/users/me");
    expect(currentUser.status).toBe(401);
    expect(await currentUser.json()).toMatchObject({ code: "auth_error" });

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
    expect(JSON.parse(callbackBody)).toMatchObject({ code: "not_found" });
    expect(callbackBody).not.toContain("future.provider");
  });

  test("fails closed before route construction when a provider setting is absent", async () => {
    const complete = await bindings();
    const { PRIVY_JWT_ISSUER: _omitted, ...incomplete } = complete;
    await expect(createProductionHttpWorker(incomplete)).rejects.toThrow(
      "HTTP worker configuration is incomplete or invalid",
    );
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
});
