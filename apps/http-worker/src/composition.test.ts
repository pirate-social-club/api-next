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
    AUTH_UPSTREAM_JWT_JWKS_URL: "https://issuer.test/jwks.json",
    AUTH_UPSTREAM_JWT_ISSUER: "issuer-test",
    AUTH_UPSTREAM_JWT_AUDIENCE: "pirate-test",
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
    expect((await jwks.json()) as unknown).toMatchObject({
      keys: [{ alg: "RS256", use: "sig", key_ops: ["verify"] }],
    });
  });

  test("fails closed before route construction when a provider setting is absent", async () => {
    const complete = await bindings();
    const { AUTH_UPSTREAM_JWT_ISSUER: _omitted, ...incomplete } = complete;
    await expect(createProductionHttpWorker(incomplete)).rejects.toThrow(
      "HTTP worker configuration is incomplete or invalid",
    );
  });
});
