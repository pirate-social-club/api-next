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
  const jwk = {
    kty: "RSA" as const,
    n: exported.n as string,
    e: exported.e as string,
    alg: "RS256" as const,
    use: "sig" as const,
    key_ops: ["verify"] as const,
    kid,
  };
  return { privateKey: pair.privateKey, jwk };
}

async function ecKeyMaterial() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const jwk = {
    kty: "EC" as const,
    crv: "P-256" as const,
    x: exported.x as string,
    y: exported.y as string,
    alg: "ES256" as const,
    use: "sig" as const,
    key_ops: ["verify"] as const,
    kid: "ec-provider-key",
  };
  return { privateKey: pair.privateKey, jwk };
}

async function signToken(
  privateKey: CryptoKey,
  kid: string,
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  signingAlgorithm: "RS256" | "ES256" = "RS256",
): Promise<string> {
  const encodedHeader = encode({ alg: signingAlgorithm, typ: "JWT", kid, ...header });
  const encodedClaims = encode({
    iss: "https://provider.test",
    aud: "pirate-api-next",
    sub: "usr_provider",
    iat: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 300,
    ...claims,
  });
  const signature = await crypto.subtle.sign(
    signingAlgorithm === "RS256"
      ? { name: "RSASSA-PKCS1-v1_5" }
      : { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  );
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  const encodedSignature = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `${encodedHeader}.${encodedClaims}.${encodedSignature}`;
}

function adapterFor(fetcher: SessionProofFetcher, nowMs = () => NOW_SECONDS * 1_000) {
  return makeJwksSessionProofVerifier({
    privy: {
      jwksUrl: "https://provider.test/jwks",
      issuer: "https://provider.test",
      audience: "pirate-api-next",
    },
    jwt: {
      jwksUrl: "https://provider.test/jwks",
      issuer: "https://provider.test",
      audience: "pirate-api-next",
    },
    fetcher,
    nowMs,
  });
}

describe("workerd JWKS session-proof adapters", () => {
  it("verifies JWT and Privy proofs with a bounded cached fake JWKS", async () => {
    const material = await keyMaterial();
    let fetchCount = 0;
    const fetcher: SessionProofFetcher = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ keys: [material.jwk] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const adapter = adapterFor(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    expect(await Effect.runPromise(adapter.verifyJwt({ jwt: token }))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
    });
    expect(await Effect.runPromise(adapter.verifyJwt({ jwt: token }))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
    });
    expect(fetchCount).toBe(1);

    const privy = await signToken(material.privateKey, material.jwk.kid, {
      wallet_address: "0xabc",
    });
    expect(
      await Effect.runPromise(
        adapter.verifyPrivy({
          accessToken: privy,
          identityToken: null,
          walletAddress: "0xabc",
        }),
      ),
    ).toEqual({ sourceUserId: "usr_provider", classification: "user" });
  });

  it("verifies ES256 P-256 proofs with the same claim and cache protections", async () => {
    const material = await ecKeyMaterial();
    let fetchCount = 0;
    const fetcher: SessionProofFetcher = async () => {
      fetchCount += 1;
      return new Response(JSON.stringify({ keys: [material.jwk] }), { status: 200 });
    };
    const adapter = adapterFor(fetcher);
    const token = await signToken(
      material.privateKey,
      material.jwk.kid,
      { wallet_address: "0xabc" },
      {},
      "ES256",
    );

    expect(await Effect.runPromise(adapter.verifyJwt({ jwt: token }))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
    });
    expect(
      await Effect.runPromise(
        adapter.verifyPrivy({ accessToken: token, identityToken: null, walletAddress: "0xabc" }),
      ),
    ).toEqual({ sourceUserId: "usr_provider", classification: "user" });
    expect(fetchCount).toBe(1);
  });

  it("rejects EC keys with an invalid curve, algorithm, or private material", async () => {
    const material = await ecKeyMaterial();
    const token = await signToken(material.privateKey, material.jwk.kid, {}, {}, "ES256");
    const expectRejected = async (jwk: unknown) => {
      const adapter = adapterFor(
        async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 }),
      );
      const exit = await Effect.runPromiseExit(adapter.verifyJwt({ jwt: token }));
      expect(Exit.isFailure(exit)).toBe(true);
    };

    await expectRejected({ ...material.jwk, crv: "P-384" });
    await expectRejected({ ...material.jwk, alg: "RS256" });
    await expectRejected({ ...material.jwk, d: "private-key-material" });
  });

  it("fails closed for malformed claims, headers, signatures, and proof binding", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async () =>
      new Response(JSON.stringify({ keys: [material.jwk] }), { status: 200 });
    const adapter = adapterFor(fetcher);
    const valid = await signToken(material.privateKey, material.jwk.kid);
    const expectRejected = async (effect: ReturnType<typeof adapter.verifyJwt>) => {
      const exit = await Effect.runPromiseExit(effect);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isSuccess(exit)) throw new Error("expected rejection");
      expect(exit.cause).toBeDefined();
    };

    await expectRejected(adapter.verifyJwt({ jwt: "not-a-jwt" }));
    await expectRejected(
      adapter.verifyJwt({
        jwt: await signToken(material.privateKey, material.jwk.kid, {}, { alg: "HS256" }),
      }),
    );
    await expectRejected(
      adapter.verifyJwt({
        jwt: await signToken(material.privateKey, material.jwk.kid, { exp: NOW_SECONDS - 1 }),
      }),
    );
    await expectRejected(
      adapter.verifyPrivy({
        accessToken: valid,
        identityToken: await signToken(material.privateKey, material.jwk.kid, { sub: "usr_other" }),
        walletAddress: null,
      }),
    );
    await expectRejected(
      adapter.verifyPrivy({ accessToken: valid, identityToken: null, walletAddress: "0xwrong" }),
    );
    expect(String(valid)).not.toContain("provider-secret");
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
      jwt: { jwksUrl: "https://provider.test/jwks", issuer: "https://provider.test" },
      fetcher,
      fetchTimeoutMs: 5,
      nowMs: () => NOW_SECONDS * 1_000,
    });
    const token = await signToken(material.privateKey, material.jwk.kid);
    const started = Date.now();
    await expect(Effect.runPromise(adapter.verifyJwt({ jwt: token }))).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(500);
  });
});
