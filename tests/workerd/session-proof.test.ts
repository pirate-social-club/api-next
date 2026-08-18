import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import {
  makeJwksSessionProofVerifier,
  type SessionProofFetcher,
} from "../../packages/platform-cf/src/session-proof";

const NOW_SECONDS = 1_800_000_000;

function encode(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

async function keyMaterial() {
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
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const thumbprint = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify({ e: exported.e, kty: "RSA", n: exported.n })),
  );
  let binary = "";
  for (const byte of new Uint8Array(thumbprint)) binary += String.fromCharCode(byte);
  const kid = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
  return {
    privateKey: pair.privateKey,
    jwk: {
      kty: "RSA" as const,
      n: exported.n as string,
      e: exported.e as string,
      alg: "RS256" as const,
      use: "sig" as const,
      key_ops: ["verify"] as const,
      kid,
    },
  };
}

async function signToken(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const encodedHeader = encode({ alg: "RS256", typ: "JWT", kid, ...header });
  const encodedClaims = encode({
    iss: "https://provider.test",
    aud: "pirate-api-next",
    sub: "usr_provider",
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    { name: "RSASSA-PKCS1-v1_5" },
    privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return `${encodedHeader}.${encodedClaims}.${btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")}`;
}

function adapterFor(fetcher: SessionProofFetcher, nowMs = () => NOW_SECONDS * 1_000) {
  return makeJwksSessionProofVerifier({
    privy: {
      jwksUrl: "https://provider.test/jwks",
      issuer: "https://provider.test",
      audience: "pirate-api-next",
    },
    fetcher,
    nowMs,
  });
}

const verify = (adapter: ReturnType<typeof adapterFor>, token: string) =>
  adapter.verifyPrivy({ accessToken: token, identityToken: null, walletAddress: null });

describe("workerd Privy JWKS session-proof adapter", () => {
  it("verifies direct Privy proofs with a bounded cached JWKS", async () => {
    const material = await keyMaterial();
    let fetchCount = 0;
    const fetcher: SessionProofFetcher = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ keys: [material.jwk] }), { status: 200 });
    };
    const adapter = adapterFor(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    expect(await Effect.runPromise(verify(adapter, token))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
    });
    expect(await Effect.runPromise(verify(adapter, token))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
    });
    expect(fetchCount).toBe(1);
  });

  it("fails closed for malformed claims, headers, and identity binding", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async () =>
      new Response(JSON.stringify({ keys: [material.jwk] }), { status: 200 });
    const adapter = adapterFor(fetcher);
    const valid = await signToken(material.privateKey, material.jwk.kid);
    const expectRejected = async (token: string) => {
      const exit = await Effect.runPromiseExit(verify(adapter, token));
      expect(Exit.isFailure(exit)).toBe(true);
    };

    await expectRejected("not-a-jwt");
    await expectRejected(
      await signToken(material.privateKey, material.jwk.kid, {}, { alg: "HS256" }),
    );
    await expectRejected(
      await signToken(material.privateKey, material.jwk.kid, { exp: NOW_SECONDS - 1 }),
    );
    expect(
      await Effect.runPromise(
        adapter.verifyPrivy({
          accessToken: valid,
          identityToken: await signToken(material.privateKey, material.jwk.kid, {
            sub: "usr_other",
          }),
          walletAddress: null,
        }),
      ).catch(() => "rejected"),
    ).toBe("rejected");
  });

  it("aborts a hanging JWKS fetch at the configured bound", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    const adapter = makeJwksSessionProofVerifier({
      privy: { jwksUrl: "https://provider.test/jwks", issuer: "https://provider.test" },
      fetcher,
      fetchTimeoutMs: 5,
      nowMs: () => NOW_SECONDS * 1_000,
    });
    const token = await signToken(material.privateKey, material.jwk.kid);
    await expect(Effect.runPromise(verify(adapter, token))).rejects.toBeDefined();
  });
});
