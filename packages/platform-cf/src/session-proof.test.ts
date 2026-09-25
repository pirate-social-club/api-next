import { describe, expect, test } from "bun:test";
import { Effect, Exit } from "effect";
import {
  makeJwksSessionProofVerifier,
  privyUserLookupUrl,
  SESSION_PROOF_MAX_JWKS_BYTES,
  SESSION_PROOF_MAX_USER_BYTES,
} from "./session-proof";

describe("Privy server API routing", () => {
  test("uses the current v1 user lookup path", () => {
    expect(privyUserLookupUrl("https://api.privy.io", "did:privy:test/user")).toBe(
      "https://api.privy.io/v1/users/did%3Aprivy%3Atest%2Fuser",
    );
  });
});

describe("Taproot provider inventory attestation", () => {
  test("binds an embedded wallet inventory to the signed Privy subject", async () => {
    const key = await makeRsaKey("taproot-key");
    const address = "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0";
    const verifier = makeJwksSessionProofVerifier({
      privy: {
        jwksUrl: "https://provider.test/jwks.json",
        issuer: "test-issuer",
        audience: "test-audience",
      },
      privyApi: { apiUrl: "https://api.privy.test", appId: "app-id", appSecret: "app-secret" },
      fetcher: async (input) =>
        input.includes("/jwks")
          ? jwksResponse([key])
          : Response.json({
              id: "did:privy:test-user",
              linked_accounts: [
                {
                  type: "wallet",
                  chain_type: "bitcoin-taproot",
                  wallet_client: "privy",
                  wallet_client_type: "privy",
                  connector_type: "embedded",
                  imported: false,
                  id: "wallet_01",
                  wallet_index: 0,
                  address,
                  public_key: `02${"11".repeat(32)}`,
                },
              ],
            }),
      nowMs: () => 1_000_000,
    });
    const result = await Effect.runPromise(
      verifier.readPrivyEmbeddedTaprootInventory({
        accessToken: await signToken(key),
        identityToken: null,
        network: "mainnet",
      }),
    );
    expect(result.sourceUserId).toBe("did:privy:test-user");
    expect(result.wallets.map((wallet) => wallet.providerId)).toEqual(["wallet_01"]);
  });
});

const encoder = new TextEncoder();

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function encodeSegment(value: unknown): string {
  return encodeBase64Url(encoder.encode(JSON.stringify(value)));
}

type TestKey = {
  readonly kid: string;
  readonly jwk: Record<string, unknown>;
  readonly privateKey: CryptoKey;
};

async function makeRsaKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    jwk: { ...exported, alg: "RS256", use: "sig", kid, key_ops: ["verify"] },
    privateKey: pair.privateKey,
  };
}

async function signToken(key: TestKey, claims: Record<string, unknown> = {}): Promise<string> {
  const header = { alg: "RS256", typ: "JWT", kid: key.kid };
  const payload = {
    sub: "did:privy:test-user",
    iss: "test-issuer",
    aud: "test-audience",
    exp: 2_000_000_000,
    ...claims,
  };
  const signingInput = `${encodeSegment(header)}.${encodeSegment(payload)}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key.privateKey,
    encoder.encode(signingInput),
  );
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`;
}

function unknownKeyToken(kid: string): string {
  const header = encodeSegment({ alg: "RS256", typ: "JWT", kid });
  const payload = encodeSegment({ sub: "did:privy:test-user" });
  return `${header}.${payload}.AQ`;
}

function jwksBody(keys: readonly TestKey[]): string {
  return JSON.stringify({ keys: keys.map((key) => key.jwk) });
}

function jwksResponse(keys: readonly TestKey[]): Response {
  return new Response(jwksBody(keys), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function jwksBodyAtByteLength(keys: readonly TestKey[], targetBytes: number): string {
  const members = keys.map((key) => key.jwk);
  const empty = JSON.stringify({ keys: members, pad: "" });
  const needed = targetBytes - encoder.encode(empty).byteLength;
  const pad = "é".repeat(Math.floor(needed / 2)) + (needed % 2 === 1 ? "x" : "");
  return JSON.stringify({ keys: members, pad });
}

type ChunkedResponse = {
  readonly response: Response;
  readonly cancelled: () => boolean;
};

function chunkedResponse(
  chunks: readonly Uint8Array[],
  init: { readonly headers?: Record<string, string> } = {},
): ChunkedResponse {
  let cancelled = false;
  let enqueued = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (enqueued >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[enqueued]);
      enqueued += 1;
    },
    cancel() {
      cancelled = true;
    },
  });
  return {
    response: new Response(stream, {
      ...(init.headers === undefined ? {} : { headers: init.headers }),
    }),
    cancelled: () => cancelled,
  };
}

type Verifier = ReturnType<typeof makeJwksSessionProofVerifier>;

function makeTestVerifier(
  fetcher: (input: string, init?: RequestInit) => Promise<Response>,
  clock: () => number,
  overrides: {
    readonly cacheTtlMs?: number;
    readonly fetchTimeoutMs?: number;
    readonly jwksRefreshCooldownMs?: number;
  } = {},
): Verifier {
  return makeJwksSessionProofVerifier({
    privy: {
      jwksUrl: "https://provider.test/jwks.json",
      issuer: "test-issuer",
      audience: "test-audience",
    },
    fetcher,
    nowMs: clock,
    fetchTimeoutMs: overrides.fetchTimeoutMs ?? 5_000,
    cacheTtlMs: overrides.cacheTtlMs ?? 300_000,
    jwksRefreshCooldownMs: overrides.jwksRefreshCooldownMs ?? 30_000,
  });
}

function deferred<A>(): {
  readonly promise: Promise<A>;
  readonly resolve: (value: A) => void;
} {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function verifyToken(verifier: Verifier, accessToken: string): Promise<boolean> {
  const exit = await Effect.runPromiseExit(
    verifier.verifyPrivy({ accessToken, identityToken: null, walletAddress: null }),
  );
  return Exit.isSuccess(exit);
}

describe("bounded provider response reads", () => {
  test("accepts a JWKS document exactly at the byte limit despite a short Content-Length", async () => {
    const key = await makeRsaKey("key-a");
    const body = jwksBodyAtByteLength([key], SESSION_PROOF_MAX_JWKS_BYTES);
    expect(encoder.encode(body).byteLength).toBe(SESSION_PROOF_MAX_JWKS_BYTES);
    const streamed = chunkedResponse([encoder.encode(body)], {
      headers: { "content-length": "1" },
    });
    let calls = 0;
    const verifier = makeTestVerifier(
      async () => {
        calls += 1;
        return streamed.response;
      },
      () => 1_000_000,
    );

    expect(await verifyToken(verifier, await signToken(key))).toBe(true);
    expect(calls).toBe(1);
    expect(streamed.cancelled()).toBe(false);
  });

  test("rejects and cancels a JWKS document one byte over the limit", async () => {
    const key = await makeRsaKey("key-a");
    const body = jwksBodyAtByteLength([key], SESSION_PROOF_MAX_JWKS_BYTES);
    const exact = encoder.encode(body);
    const over = new Uint8Array(exact.byteLength + 1);
    over.set(exact);
    over[exact.byteLength] = 0x20;
    // Keep an unread trailing chunk so the source is still open when the
    // bounded reader cancels it.
    const streamed = chunkedResponse([over, encoder.encode("trailing")]);
    const verifier = makeTestVerifier(
      async () => streamed.response,
      () => 1_000_000,
    );

    expect(await verifyToken(verifier, await signToken(key))).toBe(false);
    expect(streamed.cancelled()).toBe(true);
    expect(streamed.response.body?.locked).toBe(false);
  });

  test("accounts for multibyte UTF-8 bytes before decoding", async () => {
    const key = await makeRsaKey("key-a");
    const body = jwksBodyAtByteLength([key], SESSION_PROOF_MAX_JWKS_BYTES);
    expect(encoder.encode(body).byteLength).toBe(SESSION_PROOF_MAX_JWKS_BYTES);
    const overBody = `${body}\u00e9`;
    expect(encoder.encode(overBody).byteLength).toBe(SESSION_PROOF_MAX_JWKS_BYTES + 2);

    const exact = chunkedResponse([encoder.encode(body)]);
    const exactVerifier = makeTestVerifier(
      async () => exact.response,
      () => 1_000_000,
    );
    expect(await verifyToken(exactVerifier, await signToken(key))).toBe(true);
    expect(exact.cancelled()).toBe(false);

    const over = chunkedResponse([encoder.encode(overBody), encoder.encode("trailing")]);
    const overVerifier = makeTestVerifier(
      async () => over.response,
      () => 1_000_000,
    );
    expect(await verifyToken(overVerifier, await signToken(key))).toBe(false);
    expect(over.cancelled()).toBe(true);
  });

  test("releases the reader after a stream failure and recovers later", async () => {
    const key = await makeRsaKey("key-a");
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"keys":['));
        controller.error(new Error("stream failed"));
      },
    });
    const failingResponse = new Response(failing);
    let clock = 1_000_000;
    let calls = 0;
    const verifier = makeTestVerifier(
      async () => {
        calls += 1;
        return calls === 1 ? failingResponse : jwksResponse([key]);
      },
      () => clock,
    );

    expect(await verifyToken(verifier, await signToken(key))).toBe(false);
    expect(failingResponse.body?.locked).toBe(false);
    expect(await verifyToken(verifier, await signToken(key))).toBe(false);
    expect(calls).toBe(1);

    clock += 30_001;
    expect(await verifyToken(verifier, await signToken(key))).toBe(true);
    expect(calls).toBe(2);
  });

  test("bounds the provider user document read", async () => {
    const key = await makeRsaKey("key-a");
    const oversizedUser = `${JSON.stringify({
      id: "did:privy:test-user",
      linked_accounts: [],
    })}${" ".repeat(SESSION_PROOF_MAX_USER_BYTES)}`;
    const streamed = chunkedResponse([encoder.encode(oversizedUser), encoder.encode("trailing")]);
    let lookupCalls = 0;
    const verifier = makeJwksSessionProofVerifier({
      privy: {
        jwksUrl: "https://provider.test/jwks.json",
        issuer: "test-issuer",
        audience: "test-audience",
      },
      privyApi: { apiUrl: "https://api.privy.test", appId: "app-id", appSecret: "app-secret" },
      fetcher: async (input) => {
        if (input.includes("/jwks")) return jwksResponse([key]);
        lookupCalls += 1;
        return streamed.response;
      },
      nowMs: () => 1_000_000,
    });

    expect(await verifyToken(verifier, await signToken(key))).toBe(true);
    expect(lookupCalls).toBe(1);
    expect(streamed.cancelled()).toBe(true);
    expect(streamed.response.body?.locked).toBe(false);
  });

  test("propagates interruption to a pending provider user lookup", async () => {
    const key = await makeRsaKey("key-a");
    const started = deferred<void>();
    const settled = deferred<void>();
    let lookupSignal: AbortSignal | undefined;
    const verifier = makeJwksSessionProofVerifier({
      privy: {
        jwksUrl: "https://provider.test/jwks.json",
        issuer: "test-issuer",
        audience: "test-audience",
      },
      privyApi: {
        apiUrl: "https://api.privy.test",
        appId: "app-id",
        appSecret: "app-secret",
      },
      fetcher: async (input, init) => {
        if (input.includes("/jwks")) return jwksResponse([key]);
        lookupSignal = init?.signal ?? undefined;
        started.resolve();
        try {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        } finally {
          settled.resolve();
        }
      },
      nowMs: () => 1_000_000,
    });
    const parent = new AbortController();
    const result = Effect.runPromiseExit(
      verifier.verifyPrivy({
        accessToken: await signToken(key),
        identityToken: null,
        walletAddress: null,
      }),
      { signal: parent.signal },
    );

    await started.promise;
    parent.abort(new DOMException("cancelled", "AbortError"));
    expect((await result)._tag).toBe("Failure");
    await settled.promise;
    expect(lookupSignal?.aborted).toBe(true);
    expect(lookupSignal?.reason).toMatchObject({ name: "AbortError" });
  });
});

describe("JWKS refresh control", () => {
  test("parent interruption wins the pending JWKS deadline race", async () => {
    const key = await makeRsaKey("key-a");
    const started = deferred<void>();
    const settled = deferred<void>();
    let providerSignal: AbortSignal | undefined;
    const verifier = makeTestVerifier(
      async (_input, init) => {
        providerSignal = init?.signal ?? undefined;
        started.resolve();
        try {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        } finally {
          settled.resolve();
        }
      },
      () => 1_000_000,
      { fetchTimeoutMs: 100 },
    );
    const parent = new AbortController();
    const result = Effect.runPromiseExit(
      verifier.verifyPrivy({
        accessToken: await signToken(key),
        identityToken: null,
        walletAddress: null,
      }),
      { signal: parent.signal },
    );

    await started.promise;
    parent.abort(new DOMException("cancelled", "AbortError"));
    expect((await result)._tag).toBe("Failure");
    await settled.promise;
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toMatchObject({ name: "AbortError" });
    await Bun.sleep(120);
    expect(providerSignal?.reason).toMatchObject({ name: "AbortError" });
  });

  test("the JWKS deadline aborts and joins a pending provider request", async () => {
    const key = await makeRsaKey("key-a");
    const settled = deferred<void>();
    let providerSignal: AbortSignal | undefined;
    const verifier = makeTestVerifier(
      async (_input, init) => {
        providerSignal = init?.signal ?? undefined;
        try {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          });
        } finally {
          settled.resolve();
        }
      },
      () => 1_000_000,
      { fetchTimeoutMs: 10 },
    );

    expect(await verifyToken(verifier, await signToken(key))).toBe(false);
    await settled.promise;
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toMatchObject({ name: "TimeoutError" });
  });

  test("cancels and unlocks a pending JWKS body when interrupted", async () => {
    const key = await makeRsaKey("key-a");
    const reading = deferred<void>();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull() {
        reading.resolve();
      },
      cancel() {
        cancelled = true;
      },
    });
    const response = new Response(body);
    const verifier = makeTestVerifier(
      async () => response,
      () => 1_000_000,
    );
    const parent = new AbortController();
    const result = Effect.runPromiseExit(
      verifier.verifyPrivy({
        accessToken: await signToken(key),
        identityToken: null,
        walletAddress: null,
      }),
      { signal: parent.signal },
    );

    await reading.promise;
    parent.abort(new DOMException("cancelled", "AbortError"));
    expect((await result)._tag).toBe("Failure");
    expect(cancelled).toBe(true);
    expect(response.body?.locked).toBe(false);
  });

  test("keeps a shared refresh alive for a remaining waiter", async () => {
    const key = await makeRsaKey("key-a");
    const token = await signToken(key);
    const started = deferred<void>();
    const release = deferred<Response>();
    let calls = 0;
    let providerSignal: AbortSignal | undefined;
    const verifier = makeTestVerifier(
      async (_input, init) => {
        calls += 1;
        providerSignal = init?.signal ?? undefined;
        started.resolve();
        return release.promise;
      },
      () => 1_000_000,
    );
    const firstController = new AbortController();
    const secondController = new AbortController();
    const input = { accessToken: token, identityToken: null, walletAddress: null };
    const first = Effect.runPromiseExit(verifier.verifyPrivy(input), {
      signal: firstController.signal,
    });
    const second = Effect.runPromiseExit(verifier.verifyPrivy(input), {
      signal: secondController.signal,
    });

    await started.promise;
    firstController.abort(new DOMException("cancelled", "AbortError"));
    expect((await first)._tag).toBe("Failure");
    expect(providerSignal?.aborted).toBe(false);
    release.resolve(jwksResponse([key]));
    expect((await second)._tag).toBe("Success");
    expect(calls).toBe(1);
  });

  test("shares one pending refresh across concurrent cache misses", async () => {
    const key = await makeRsaKey("key-a");
    const token = await signToken(key);
    let calls = 0;
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const verifier = makeTestVerifier(
      async () => {
        calls += 1;
        return pending;
      },
      () => 1_000_000,
    );

    const first = verifyToken(verifier, token);
    const second = verifyToken(verifier, token);
    release(jwksResponse([key]));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(calls).toBe(1);
  });

  test("bounds forced refreshes across repeated and varying unknown key IDs", async () => {
    const key = await makeRsaKey("key-a");
    let clock = 1_000_000;
    let calls = 0;
    const verifier = makeTestVerifier(
      async () => {
        calls += 1;
        return jwksResponse([key]);
      },
      () => clock,
    );

    expect(await verifyToken(verifier, await signToken(key))).toBe(true);
    expect(calls).toBe(1);
    for (const kid of ["unknown-1", "unknown-2", "unknown-3", "unknown-4"]) {
      expect(await verifyToken(verifier, unknownKeyToken(kid))).toBe(false);
    }
    expect(calls).toBe(1);

    clock += 30_001;
    expect(await verifyToken(verifier, unknownKeyToken("unknown-5"))).toBe(false);
    expect(calls).toBe(2);
    expect(await verifyToken(verifier, unknownKeyToken("unknown-6"))).toBe(false);
    expect(calls).toBe(2);
  });

  test("recovers after a failed refresh once the cooldown elapses", async () => {
    const key = await makeRsaKey("key-a");
    const token = await signToken(key);
    let clock = 1_000_000;
    let calls = 0;
    const verifier = makeTestVerifier(
      async () => {
        calls += 1;
        if (calls === 1) throw new Error("provider unavailable");
        return jwksResponse([key]);
      },
      () => clock,
    );

    expect(await verifyToken(verifier, token)).toBe(false);
    expect(calls).toBe(1);
    expect(await verifyToken(verifier, token)).toBe(false);
    expect(calls).toBe(1);

    clock += 30_001;
    expect(await verifyToken(verifier, token)).toBe(true);
    expect(calls).toBe(2);
  });

  test("stops serving cached keys once the TTL expires across repeated refresh failures", async () => {
    const key = await makeRsaKey("key-a");
    const token = await signToken(key);
    let clock = 1_000_000;
    let calls = 0;
    let providerAvailable = true;
    const verifier = makeTestVerifier(
      async () => {
        calls += 1;
        if (!providerAvailable) throw new Error("provider unavailable");
        return jwksResponse([key]);
      },
      () => clock,
      { cacheTtlMs: 1_000, jwksRefreshCooldownMs: 30_000 },
    );

    expect(await verifyToken(verifier, token)).toBe(true);
    expect(calls).toBe(1);

    clock += 1_001;
    providerAvailable = false;
    expect(await verifyToken(verifier, token)).toBe(false);
    expect(calls).toBe(1);
    expect(await verifyToken(verifier, token)).toBe(false);
    expect(calls).toBe(1);

    clock += 30_001;
    expect(await verifyToken(verifier, token)).toBe(false);
    expect(calls).toBe(2);

    clock += 30_001;
    expect(await verifyToken(verifier, token)).toBe(false);
    expect(calls).toBe(3);

    providerAvailable = true;
    clock += 30_001;
    expect(await verifyToken(verifier, token)).toBe(true);
    expect(calls).toBe(4);
  });

  test("accepts a legitimate rotation and a new key after the cooldown", async () => {
    const keyA = await makeRsaKey("key-a");
    const keyB = await makeRsaKey("key-b");
    const keyC = await makeRsaKey("key-c");
    let available: readonly TestKey[] = [keyA];
    let clock = 1_000_000;
    let calls = 0;
    const verifier = makeTestVerifier(
      async () => {
        calls += 1;
        return jwksResponse(available);
      },
      () => clock,
    );

    expect(await verifyToken(verifier, await signToken(keyA))).toBe(true);
    expect(calls).toBe(1);

    const tokenB = await signToken(keyB);
    expect(await verifyToken(verifier, tokenB)).toBe(false);
    expect(calls).toBe(1);

    available = [keyA, keyB];
    clock += 30_001;
    expect(await verifyToken(verifier, tokenB)).toBe(true);
    expect(calls).toBe(2);

    const tokenC = await signToken(keyC);
    expect(await verifyToken(verifier, tokenC)).toBe(false);
    expect(calls).toBe(2);

    available = [keyA, keyB, keyC];
    clock += 30_001;
    expect(await verifyToken(verifier, tokenC)).toBe(true);
    expect(calls).toBe(3);
  });

  test("rejects an invalid signature without a refresh", async () => {
    const keyA = await makeRsaKey("key-a");
    const impostor = await makeRsaKey("key-a");
    let calls = 0;
    const verifier = makeTestVerifier(
      async () => {
        calls += 1;
        return jwksResponse([keyA]);
      },
      () => 1_000_000,
    );

    expect(await verifyToken(verifier, await signToken(keyA))).toBe(true);
    expect(calls).toBe(1);
    expect(await verifyToken(verifier, await signToken(impostor))).toBe(false);
    expect(calls).toBe(1);
  });
});
