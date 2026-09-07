import type { HttpWorkerBindings } from "./composition.ts";

function toPem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const base64 = Buffer.from(bytes).toString("base64");
  const lines = base64.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

export async function makeHttpWorkerTestBindings(
  connectionString = "postgres://test.invalid/api_next",
): Promise<HttpWorkerBindings> {
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
    CONTROL_PLANE: { connectionString },
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
    PRIVY_API_URL: "https://api.privy.test",
    PRIVY_JWKS_URL: "https://auth.privy.test/jwks.json",
    PRIVY_JWT_ISSUER: "privy-test",
    PRIVY_JWT_AUDIENCE: "privy-test",
    COMMUNITY_PURCHASE_FUNDING_RPC_URL: "https://rpc.test",
    MEGAPOT_REWARDS_ENABLED: "false",
    MEGAPOT_CHAIN_ID: "84532",
    MEGAPOT_V2_RPC_URL: "https://base-sepolia-rpc.test",
    MEGAPOT_ATTESTATION_ID: "megapot-base-sepolia-v2",
    MEGAPOT_REQUIRED_CONFIRMATIONS: "3",
  };
}
