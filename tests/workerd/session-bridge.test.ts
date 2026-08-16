/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { describe, expect, it } from "vitest";
import {
  MAX_SESSION_TOKEN_LENGTH,
  makeSessionBridge,
  makeSessionBridgeFromEnv,
  SessionBridgeError,
} from "../../packages/platform-cf/src/session-bridge";
import { SESSION_CONFORMANCE_CORPUS } from "../../packages/testing/src/session-bridge";

const NOW = Math.floor(Date.now() / 1_000);

function toBase64(bytes: ArrayBufferLike): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function toPem(label: "PRIVATE KEY" | "PUBLIC KEY", bytes: ArrayBuffer): string {
  const base64 = toBase64(bytes);
  const lines = base64.match(/.{1,64}/gu)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

async function keyMaterial(): Promise<{
  readonly privateKey: CryptoKey;
  readonly privatePem: string;
  readonly publicPem: string;
  readonly publicDer: ArrayBuffer;
}> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2_048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const publicDer = await crypto.subtle.exportKey("spki", pair.publicKey);
  return {
    privateKey: pair.privateKey,
    privatePem: toPem("PRIVATE KEY", await crypto.subtle.exportKey("pkcs8", pair.privateKey)),
    publicPem: toPem("PUBLIC KEY", publicDer),
    publicDer,
  };
}

function encodeJson(value: unknown): string {
  return toBase64(new TextEncoder().encode(JSON.stringify(value)).buffer)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function encodeBytes(bytes: Uint8Array): string {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return toBase64(owned.buffer).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function signedToken(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  const encodedHeader = encodeJson(header);
  const encodedClaims = encodeJson(claims);
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  return `${encodedHeader}.${encodedClaims}.${encodeBytes(new Uint8Array(signature))}`;
}

const header = (kid?: string): Record<string, unknown> => ({
  alg: "RS256",
  typ: "JWT",
  ...(kid === undefined ? {} : { kid }),
});

const claims = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: "pirate-api",
  aud: "pirate-app",
  sub: "usr_workerd_session",
  scope: "pirate_app_session",
  iat: NOW - 10,
  exp: NOW + 3_590,
  ...overrides,
});

function matrixHeader(
  recipe: (typeof SESSION_CONFORMANCE_CORPUS)[number]["recipe"],
): Record<string, unknown> {
  return {
    alg: "RS256",
    typ: "JWT",
    ...recipe.header,
  };
}

function matrixClaims(
  recipe: (typeof SESSION_CONFORMANCE_CORPUS)[number]["recipe"],
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    iss: "pirate-api",
    aud: "pirate-app",
    sub: "usr_session_vector",
    scope: "pirate_app_session",
    iat: NOW,
    exp: NOW + 3_600,
    ...recipe.claims,
  };
  for (const claim of recipe.omitClaims ?? []) delete result[claim];
  return result;
}

async function expectCode(
  action: () => Promise<unknown>,
  code: SessionBridgeError["code"],
): Promise<void> {
  await expect(action()).rejects.toMatchObject({ _tag: "SessionBridgeError", code });
}

describe("session bridge WebCrypto primitives (workerd)", () => {
  it("uses workerd's extractable SPKI JWK export as the public-key authority", async () => {
    const material = await keyMaterial();
    const imported = await crypto.subtle.importKey(
      "spki",
      material.publicDer,
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      true,
      ["verify"],
    );
    const exported = (await crypto.subtle.exportKey("jwk", imported)) as Record<string, unknown>;
    expect(exported).toMatchObject({
      kty: "RSA",
      n: expect.any(String),
      e: expect.any(String),
    });
    for (const member of ["d", "dp", "dq", "p", "q", "qi", "oth"]) {
      expect(exported[member]).toBeUndefined();
    }
  });

  it("mints and verifies the exact shared claims and publishes public-only JWKS", async () => {
    const material = await keyMaterial();
    const bridge = await makeSessionBridgeFromEnv({
      PIRATE_APP_JWT_PRIVATE_KEY: material.privatePem,
      PIRATE_APP_JWT_PUBLIC_KEY: material.publicPem,
      PIRATE_APP_JWT_ISSUER: "pirate-api",
      PIRATE_APP_JWT_AUDIENCE: "pirate-app",
      PIRATE_APP_JWT_TTL_SECONDS: "3600",
    });

    const token = await bridge.sign({
      sub: "usr_workerd_session",
      scope: "pirate_app_session",
      iat: NOW - 10,
      exp: NOW + 3_590,
    });
    const verified = await bridge.verify(token);
    expect(verified).toEqual({
      iss: "pirate-api",
      aud: "pirate-app",
      sub: "usr_workerd_session",
      scope: "pirate_app_session",
      iat: NOW - 10,
      exp: NOW + 3_590,
    });

    const jwks = bridge.jwks();
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      key_ops: ["verify"],
    });
    expect(jwks.keys[0]?.kid).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(JSON.stringify(jwks)).not.toMatch(/"(?:d|dp|dq|p|q|oth)"/u);
    expect(JSON.stringify(jwks)).not.toContain(material.privatePem);
    const publicJwk = jwks.keys[0] as (typeof jwks.keys)[number];
    const thumbprintInput = JSON.stringify({
      e: publicJwk.e,
      kty: publicJwk.kty,
      n: publicJwk.n,
    });
    const thumbprintDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(thumbprintInput),
    );
    expect(publicJwk.kid).toBe(
      toBase64(thumbprintDigest).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, ""),
    );
  });

  it("fails closed for algorithm, header, signature, key, and claim violations", async () => {
    const material = await keyMaterial();
    const other = await keyMaterial();
    const bridge = await makeSessionBridge({
      privateKeyPem: material.privatePem,
      publicKeyPem: material.publicPem,
      nowSeconds: () => NOW,
    });
    const publicOnly = await makeSessionBridge({
      publicKeyPem: other.publicPem,
      nowSeconds: () => NOW,
    });
    const valid = await signedToken(material.privateKey, header(), claims());

    await expectCode(
      () =>
        signedToken(material.privateKey, { alg: "HS256", typ: "JWT" }, claims()).then(
          bridge.verify,
        ),
      "token_header_invalid",
    );
    await expectCode(
      () =>
        signedToken(material.privateKey, { alg: "RS256", typ: "JWS" }, claims()).then(
          bridge.verify,
        ),
      "token_header_invalid",
    );
    await expectCode(
      () =>
        signedToken(material.privateKey, { ...header(), kid: "wrong" }, claims()).then(
          bridge.verify,
        ),
      "token_header_invalid",
    );
    const validParts = valid.split(".");
    const validSignature = validParts[2] as string;
    const malformedSignature = [
      validParts[0],
      validParts[1],
      `${validSignature.startsWith("A") ? "B" : "A"}${validSignature.slice(1)}`,
    ].join(".");
    await expectCode(() => bridge.verify(malformedSignature), "token_signature_invalid");
    await expectCode(() => publicOnly.verify(valid), "token_signature_invalid");
    await expectCode(
      () =>
        signedToken(material.privateKey, header(), claims({ iss: "other-issuer" })).then(
          bridge.verify,
        ),
      "claims_invalid",
    );
    await expectCode(
      () =>
        signedToken(material.privateKey, header(), claims({ aud: "other-audience" })).then(
          bridge.verify,
        ),
      "claims_invalid",
    );
    await expectCode(
      () =>
        signedToken(material.privateKey, header(), claims({ exp: NOW - 1 })).then(bridge.verify),
      "token_expired",
    );
    await expectCode(
      () =>
        signedToken(material.privateKey, header(), claims({ iat: NOW + 1 })).then(bridge.verify),
      "token_not_yet_valid",
    );
    await expectCode(
      () =>
        signedToken(material.privateKey, header(), claims({ nbf: NOW + 1 })).then(bridge.verify),
      "token_not_yet_valid",
    );
    await expectCode(
      () =>
        signedToken(material.privateKey, header(), claims({ exp: "not-a-number" })).then(
          bridge.verify,
        ),
      "claims_invalid",
    );
    await expectCode(
      () => bridge.verify("A".repeat(MAX_SESSION_TOKEN_LENGTH + 1)),
      "token_malformed",
    );
    await expectCode(() => bridge.verify("not-a-jwt"), "token_malformed");

    try {
      await bridge.verify(malformedSignature);
      throw new Error("expected verification failure");
    } catch (cause) {
      expect(cause).toBeInstanceOf(SessionBridgeError);
      expect(String(cause)).not.toContain(malformedSignature);
      expect(String(cause)).not.toContain(material.privatePem);
    }
  });

  it("requires matching key material and does not mint from a public-only verifier", async () => {
    const material = await keyMaterial();
    const other = await keyMaterial();
    await expect(
      makeSessionBridge({ privateKeyPem: other.privatePem, publicKeyPem: material.publicPem }),
    ).rejects.toMatchObject({ code: "key_pair_mismatch" });

    const verifier = await makeSessionBridge({ publicKeyPem: material.publicPem });
    await expectCode(() => verifier.sign({ sub: "usr_workerd_session" }), "configuration_invalid");
  });

  it("runs the complete 32-vector matrix in workerd", async () => {
    const material = await keyMaterial();
    const wrong = await keyMaterial();
    const expectedRejects = new Set([
      "reject-wrong-algorithm",
      "reject-wrong-typ-contract",
      "reject-wrong-issuer",
      "reject-wrong-audience",
      "reject-missing-sub",
      "reject-empty-sub",
      "contract-reject-missing-iat",
      "contract-reject-missing-exp",
      "reject-malformed-exp",
      "reject-zero-ttl-exp",
      "reject-negative-ttl-exp",
      "reject-expired",
      "reject-not-yet-valid",
      "reject-malformed-signature",
      "reject-wrong-public-key",
      "contract-reject-malformed-iat",
      "contract-reject-nonstring-scope",
    ]);
    const observations: Array<{ readonly id: string; readonly result: "accept" | "reject" }> = [];

    for (const vector of SESSION_CONFORMANCE_CORPUS) {
      let token = await signedToken(
        material.privateKey,
        matrixHeader(vector.recipe),
        matrixClaims(vector.recipe),
      );
      if (vector.recipe.signature === "malformed") {
        const parts = token.split(".");
        const signature = parts[2] ?? "";
        token = [
          parts[0],
          parts[1],
          `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`,
        ].join(".");
      }
      const bridge = await makeSessionBridge({
        publicKeyPem:
          vector.id === "reject-wrong-public-key" ? wrong.publicPem : material.publicPem,
        nowSeconds: () => NOW,
      });
      let result: "accept" | "reject" = "accept";
      try {
        await bridge.verify(token);
      } catch {
        result = "reject";
      }
      observations.push({ id: vector.id, result });
    }

    expect(observations).toHaveLength(32);
    expect(
      observations
        .filter((observation) => observation.result === "reject")
        .map((observation) => observation.id)
        .sort(),
    ).toEqual([...expectedRejects].sort());
    expect(observations.filter((observation) => observation.result === "accept")).toHaveLength(15);
  });
});
