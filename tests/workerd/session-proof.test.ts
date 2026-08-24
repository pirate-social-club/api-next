import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";
import { PersonaWalletProofRejected } from "../../packages/application/src/use-cases/personas";
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
    aud: "api-next-proof-test",
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
      audience: "api-next-proof-test",
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

  it("returns the signed wallet claim in canonical lowercase form", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async () =>
      new Response(JSON.stringify({ keys: [material.jwk] }), { status: 200 });
    const adapter = adapterFor(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid, {
      wallet_address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(
      await Effect.runPromise(
        adapter.verifyPrivy({
          accessToken: token,
          identityToken: null,
          walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        }),
      ),
    ).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
      walletAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
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
    await expectRejected(
      await signToken(material.privateKey, material.jwk.kid, { user_id: "usr_provider" }),
    );
    await expectRejected(
      await signToken(material.privateKey, material.jwk.kid, { scope: "api-next-machine" }),
    );
    await expectRejected(
      await signToken(material.privateKey, material.jwk.kid, { classification: "user" }),
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
      privy: {
        jwksUrl: "https://provider.test/jwks",
        issuer: "https://provider.test",
        audience: "api-next-proof-test",
      },
      fetcher,
      fetchTimeoutMs: 5,
      nowMs: () => NOW_SECONDS * 1_000,
    });
    const token = await signToken(material.privateKey, material.jwk.kid);
    await expect(Effect.runPromise(verify(adapter, token))).rejects.toBeDefined();
  });
});

describe("workerd Privy linked-wallet lookup", () => {
  const embeddedWallet = `0x${"b".repeat(40)}`;
  const otherWallet = `0x${"c".repeat(40)}`;
  const embeddedAccount = {
    type: "wallet",
    chain_type: "ethereum",
    address: `0x${"bB".repeat(20)}`,
    wallet_client: "privy",
  };
  const indexedEmbeddedAccount = {
    ...embeddedAccount,
    id: null,
    wallet_client_type: "privy",
    connector_type: "embedded",
    imported: false,
    wallet_index: 2,
  };
  const solanaAccount = { type: "wallet", chain_type: "solana", address: "not-an-evm-address" };

  const adapterWithApi = (fetcher: SessionProofFetcher) =>
    makeJwksSessionProofVerifier({
      privy: {
        jwksUrl: "https://provider.test/jwks",
        issuer: "https://provider.test",
        audience: "api-next-proof-test",
      },
      privyApi: {
        apiUrl: "https://provider.test",
        appId: "privy-test",
        appSecret: "test-secret",
      },
      fetcher,
      nowMs: () => NOW_SECONDS * 1_000,
    });

  const jwksResponse = (jwk: unknown) =>
    new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
  const userResponse = (accounts: readonly unknown[]) =>
    new Response(JSON.stringify({ id: "usr_provider", linked_accounts: accounts }), {
      status: 200,
    });

  it("attaches the single provider-linked wallet when the token carries no claim", async () => {
    const material = await keyMaterial();
    let authorization: string | undefined;
    let appIdHeader: string | undefined;
    const fetcher: SessionProofFetcher = async (input, init) => {
      if (input.includes("/api/v1/users/")) {
        const headers = init?.headers as Record<string, string> | undefined;
        authorization = headers?.authorization;
        appIdHeader = headers?.["privy-app-id"];
        return userResponse([embeddedAccount, solanaAccount]);
      }
      return jwksResponse(material.jwk);
    };
    const adapter = adapterWithApi(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    expect(await Effect.runPromise(verify(adapter, token))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
      walletAddress: embeddedWallet,
    });
    expect(authorization).toBe(`Basic ${btoa("privy-test:test-secret")}`);
    expect(appIdHeader).toBe("privy-test");
  });

  it("resolves a requested wallet only when the provider attests it", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async (input) =>
      input.includes("/api/v1/users/")
        ? userResponse([embeddedAccount])
        : jwksResponse(material.jwk);
    const adapter = adapterWithApi(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    expect(
      await Effect.runPromise(
        adapter.verifyPrivy({
          accessToken: token,
          identityToken: null,
          walletAddress: embeddedWallet,
        }),
      ),
    ).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
      walletAddress: embeddedWallet,
    });
    const rejected = await Effect.runPromiseExit(
      adapter.verifyPrivy({ accessToken: token, identityToken: null, walletAddress: otherWallet }),
    );
    expect(Exit.isFailure(rejected)).toBe(true);
  });

  it("fails open without a wallet when the lookup fails", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async (input) =>
      input.includes("/api/v1/users/")
        ? new Response("upstream failure", { status: 500 })
        : jwksResponse(material.jwk);
    const adapter = adapterWithApi(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    expect(await Effect.runPromise(verify(adapter, token))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
    });
    const requested = await Effect.runPromiseExit(
      adapter.verifyPrivy({
        accessToken: token,
        identityToken: null,
        walletAddress: embeddedWallet,
      }),
    );
    expect(Exit.isFailure(requested)).toBe(true);
  });

  it("never selects from multiple linked wallets", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async (input) =>
      input.includes("/api/v1/users/")
        ? userResponse([embeddedAccount, { ...embeddedAccount, address: otherWallet }])
        : jwksResponse(material.jwk);
    const adapter = adapterWithApi(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    expect(await Effect.runPromise(verify(adapter, token))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
    });
  });

  it("does not call the provider API when the token carries a wallet claim", async () => {
    const material = await keyMaterial();
    let lookupCount = 0;
    const fetcher: SessionProofFetcher = async (input) => {
      if (input.includes("/api/v1/users/")) {
        lookupCount += 1;
        return userResponse([embeddedAccount]);
      }
      return jwksResponse(material.jwk);
    };
    const adapter = adapterWithApi(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid, {
      wallet_address: `0x${"aA".repeat(20)}`,
    });
    expect(await Effect.runPromise(verify(adapter, token))).toEqual({
      sourceUserId: "usr_provider",
      classification: "user",
      walletAddress: `0x${"a".repeat(40)}`,
    });
    expect(lookupCount).toBe(0);
  });

  it("attests only the embedded EVM wallet at the server-reserved HD index", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async (input) =>
      input.includes("/api/v1/users/")
        ? userResponse([
            embeddedAccount,
            { ...indexedEmbeddedAccount, address: `0x${"bB".repeat(20)}` },
            solanaAccount,
          ])
        : jwksResponse(material.jwk);
    const adapter = adapterWithApi(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    expect(
      await Effect.runPromise(
        adapter.verifyPrivyEmbeddedEvmWallet({
          accessToken: token,
          identityToken: null,
          hdWalletIndex: 2,
        }),
      ),
    ).toEqual({
      sourceUserId: "usr_provider",
      privyWalletId: null,
      hdWalletIndex: 2,
      address: embeddedWallet,
    });
  });

  it("rejects linked-wallet authority from a user document for another Privy subject", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async (input) =>
      input.includes("/api/v1/users/")
        ? new Response(
            JSON.stringify({
              id: "usr_other",
              linked_accounts: [indexedEmbeddedAccount],
            }),
            { status: 200 },
          )
        : jwksResponse(material.jwk);
    const adapter = adapterWithApi(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    const error = await Effect.runPromise(
      adapter
        .verifyPrivyEmbeddedEvmWallet({
          accessToken: token,
          identityToken: null,
          hdWalletIndex: 2,
        })
        .pipe(Effect.flip),
    );
    expect(error).toBeInstanceOf(PersonaWalletProofRejected);
    expect(error.reason).toBe("unavailable");
  });

  it("does not treat external wallets or another HD index as persona wallet authority", async () => {
    const material = await keyMaterial();
    const fetcher: SessionProofFetcher = async (input) =>
      input.includes("/api/v1/users/")
        ? userResponse([embeddedAccount, indexedEmbeddedAccount])
        : jwksResponse(material.jwk);
    const adapter = adapterWithApi(fetcher);
    const token = await signToken(material.privateKey, material.jwk.kid);
    for (const hdWalletIndex of [0, 1, 3]) {
      const error = await Effect.runPromise(
        adapter
          .verifyPrivyEmbeddedEvmWallet({
            accessToken: token,
            identityToken: null,
            hdWalletIndex,
          })
          .pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(PersonaWalletProofRejected);
      expect(error.reason).toBe("unavailable");
    }
  });

  it("fails closed when Privy returns duplicate or malformed embedded index facts", async () => {
    const material = await keyMaterial();
    const token = await signToken(material.privateKey, material.jwk.kid);
    for (const accounts of [
      [indexedEmbeddedAccount, { ...indexedEmbeddedAccount, address: otherWallet }],
      [{ ...indexedEmbeddedAccount, wallet_index: -1 }],
      [{ ...indexedEmbeddedAccount, wallet_client_type: "external" }],
      [{ ...indexedEmbeddedAccount, imported: true }],
    ]) {
      const adapter = adapterWithApi(async (input) =>
        input.includes("/api/v1/users/") ? userResponse(accounts) : jwksResponse(material.jwk),
      );
      const error = await Effect.runPromise(
        adapter
          .verifyPrivyEmbeddedEvmWallet({
            accessToken: token,
            identityToken: null,
            hdWalletIndex: 2,
          })
          .pipe(Effect.flip),
      );
      expect(error).toBeInstanceOf(PersonaWalletProofRejected);
      expect(error.reason).toBe("unavailable");
    }
  });
});
