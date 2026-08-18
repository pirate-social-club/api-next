import { describe, expect, test } from "bun:test";
import type {
  VerificationProviderCompleteInput,
  VerificationProviderStartInput,
} from "@pirate/application/verification";
import { computeVerificationRequestHash } from "@pirate/application/verification";
import { runProviderConformance } from "@pirate/testing/verification";
import { canonicalizeSignedVerifierResponse } from "@pirate/verifier-response-contract";
import { Cause, Effect, Exit, Result } from "effect";
import {
  compileZkPassportQuery,
  makeZkPassportProvider,
  makeZkPassportVerifierTransport,
  ZKPASSPORT_MANIFEST,
  ZKPASSPORT_PROTOCOL_VERSION,
  ZKPASSPORT_RP_SCOPE,
  type ZkPassportAdapterOptions,
  zkPassportConfiguration,
} from "./zkpassport.ts";

const HASH = "1".repeat(64);
const NOW = "2099-01-01T00:00:00.000Z";
const EXPIRES = "2099-01-01T01:00:00.000Z";
const REQUIREMENTS = [
  { claim_id: "age.minimum", minimum_age: "18" },
  { claim_id: "credential.subject_unique" },
  { claim_id: "document.valid" },
  { claim_id: "nationality.allowed", allowed_countries: ["GE", "US"] },
] as const;
const SCOPE = {
  kind: "named" as const,
  scope_semantics: "issuer_rp_scope" as const,
  issuer: "zkpassport",
  rp_scope: ZKPASSPORT_RP_SCOPE,
};
const RESPONSE_SECRET = "response-secret";
const RESPONSE_KEY_ID = "key-2026-08";
const NONCE = "n".repeat(32);

async function signedResult(
  input: Parameters<NonNullable<ZkPassportAdapterOptions["verifier"]>["verify"]>[0],
  overrides: Partial<{
    verdict: boolean;
    unique_identifier: string | null;
    unique_identifier_type: 0 | null;
    proof_session_id: string;
    request_hash: string;
    protocol_version: string;
    expiry: string;
    nonce: string;
    key_id: string;
  }> = {},
  signingSecret = RESPONSE_SECRET,
) {
  const unsigned = {
    proof_session_id: overrides.proof_session_id ?? input.proof_session_id,
    request_hash: overrides.request_hash ?? input.request_hash,
    verdict: overrides.verdict ?? true,
    unique_identifier:
      overrides.unique_identifier === undefined ? "raw-id" : overrides.unique_identifier,
    unique_identifier_type:
      "unique_identifier_type" in overrides ? overrides.unique_identifier_type : (0 as const),
    protocol_version: overrides.protocol_version ?? input.protocol_version,
    nonce: overrides.nonce ?? input.nonce,
    expiry: overrides.expiry ?? input.expiry,
    key_id: overrides.key_id ?? RESPONSE_KEY_ID,
  } as const;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalizeSignedVerifierResponse(unsigned)),
  );
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return {
    ...unsigned,
    signature: btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", ""),
  } as const;
}
const INPUT: VerificationProviderStartInput = {
  actor_id: "actor-1",
  intent_id: "intent-1",
  request_hash: HASH,
  method: "document",
  scope: SCOPE,
  request_mode: "dynamic",
  provider_configuration: {
    ...zkPassportConfiguration({ domain: "api.example" }),
  },
  requested_requirements: REQUIREMENTS,
  requested_claim_ids: [
    "age.minimum",
    "credential.subject_unique",
    "document.valid",
    "nationality.allowed",
  ],
  subject_binding_intent: "establish",
  protocol_version: ZKPASSPORT_PROTOCOL_VERSION,
  environment: "test",
};

function options(overrides: Partial<ZkPassportAdapterOptions> = {}): ZkPassportAdapterOptions {
  const counts = new Map<string, number>();
  return {
    domain: "api.example",
    name: "Pirate",
    verifier: {
      verify: (input) => Effect.promise(() => signedResult(input)),
    },
    clock: { now: () => NOW, expiresAt: () => EXPIRES },
    identifiers: {
      next: (kind) => {
        const next = (counts.get(kind) ?? 0) + 1;
        counts.set(kind, next);
        return `${kind}-${next}`;
      },
    },
    digest: { digest: () => Effect.succeed("a".repeat(64)) },
    verifier_response_signing_secret: RESPONSE_SECRET,
    verifier_response_signing_key_id: RESPONSE_KEY_ID,
    nonce: () => NONCE,
    ...overrides,
  };
}

function failure(exit: Exit.Exit<unknown, unknown>): unknown {
  if (!Exit.isFailure(exit)) return undefined;
  const found = Cause.findError(exit.cause);
  return Result.isSuccess(found) ? found.success : undefined;
}

function failureTag(exit: Exit.Exit<unknown, unknown>): string | undefined {
  const value = failure(exit);
  return value !== null && typeof value === "object" && "_tag" in value
    ? String(value._tag)
    : undefined;
}

test("compiles deterministic SDK query with alpha3 nationality order", () => {
  expect(
    compileZkPassportQuery({
      session_id: "session-1",
      request_hash: HASH,
      requested_requirements: REQUIREMENTS,
    }),
  ).toEqual({
    bind: { custom_data: JSON.stringify({ proof_session_id: "session-1", request_hash: HASH }) },
    age: { gte: 18 },
    nationality: { in: ["GEO", "USA"] },
  });
});

describe("ZKPassport provider", () => {
  test("passes the shared deterministic transport conformance harness", async () => {
    const { request_hash: _requestHash, requested_claim_ids: _claimIds, ...hashInput } = INPUT;
    const conformanceInput = {
      ...INPUT,
      request_hash: await computeVerificationRequestHash(
        ZKPASSPORT_MANIFEST.provider_id,
        hashInput,
      ),
    };
    await runProviderConformance({
      adapter: makeZkPassportProvider(options()),
      startInput: conformanceInput,
      submission: {
        channel: "client_result",
        payload: {
          proofs: [{}],
          queryResult: {
            bind: {
              custom_data: JSON.stringify({
                proof_session_id: "session-1",
                request_hash: conformanceInput.request_hash,
              }),
            },
            age: { gte: { expected: 18, result: true } },
            nationality: { in: { expected: ["GEO", "USA"], result: true } },
          },
        },
      },
    });
  });

  test("plans and starts an embedded SDK request without constructing the SDK in Worker code", async () => {
    const provider = makeZkPassportProvider(options());
    await expect(Effect.runPromise(provider.plan(INPUT))).resolves.toMatchObject({
      status: "supported",
      request_mode: "dynamic",
    });
    const started = await Effect.runPromise(provider.start(INPUT));
    expect(started.presentation).toMatchObject({
      kind: "embedded_sdk",
      protocol: "zkpassport",
      version: "0.14.2",
    });
    expect(
      started.presentation.kind === "embedded_sdk" && started.presentation.payload,
    ).toMatchObject({
      unique_identifier_type: 0,
      query: compileZkPassportQuery({
        session_id: "session-1",
        request_hash: HASH,
        requested_requirements: REQUIREMENTS,
      }),
    });
  });

  test("binds completion to persisted query, checks predicates, and hashes only the identifier", async () => {
    const provider = makeZkPassportProvider(options());
    const started = await Effect.runPromise(provider.start(INPUT));
    const queryResult = {
      bind: { custom_data: JSON.stringify({ proof_session_id: "session-1", request_hash: HASH }) },
      age: { gte: { expected: 18, result: true } },
      nationality: { in: { expected: ["GEO", "USA"], result: true } },
    };
    const input: VerificationProviderCompleteInput = {
      session: started.session,
      submission: { channel: "client_result", payload: { proofs: [{}], queryResult } },
    };
    const bundle = await Effect.runPromise(provider.complete(input));
    expect(bundle.subject_keys[0]?.subject_digest).toBe("a".repeat(64));
    expect(bundle.assertions.map((assertion) => assertion.claim_id)).toEqual([
      ...INPUT.requested_claim_ids,
    ]);
    expect(bundle.assertions.some((assertion) => assertion.claim_id === "human.unique")).toBe(
      false,
    );
  });

  test("rejects binding mismatch and client originalQuery before verifier work", async () => {
    let calls = 0;
    const provider = makeZkPassportProvider(
      options({
        verifier: {
          verify: (input) => {
            calls += 1;
            return Effect.promise(() => signedResult(input, { unique_identifier: "id" }));
          },
        },
      }),
    );
    const started = await Effect.runPromise(provider.start(INPUT));
    const result = await Effect.runPromiseExit(
      provider.complete({
        session: started.session,
        submission: {
          channel: "client_result",
          payload: {
            proofs: [{}],
            originalQuery: { age: { gte: 1 } },
            queryResult: { bind: { custom_data: "foreign" } },
          },
        },
      }),
    );
    expect(failureTag(result)).toBe("VerificationProviderUnboundRejected");
    expect(calls).toBe(0);
  });

  test("classifies ambiguous verifier false as unbound and predicate mismatch as rejected", async () => {
    const started = await Effect.runPromise(makeZkPassportProvider(options()).start(INPUT));
    const base = {
      bind: { custom_data: JSON.stringify({ proof_session_id: "session-1", request_hash: HASH }) },
      age: { gte: { expected: 18, result: true } },
      nationality: { in: { expected: ["GEO", "USA"], result: true } },
    };
    const falseProvider = makeZkPassportProvider(
      options({
        verifier: {
          verify: (input) =>
            Effect.promise(() =>
              signedResult(input, {
                verdict: false,
                unique_identifier: null,
                unique_identifier_type: null,
              }),
            ),
        },
      }),
    );
    const unboundExit = await Effect.runPromiseExit(
      falseProvider.complete({
        session: started.session,
        submission: { channel: "client_result", payload: { proofs: [{}], queryResult: base } },
      }),
    );
    expect(failureTag(unboundExit)).toBe("VerificationProviderUnboundRejected");
    const mismatch = { ...base, age: { gte: { expected: 19, result: true } } };
    const rejectedExit = await Effect.runPromiseExit(
      makeZkPassportProvider(options()).complete({
        session: started.session,
        submission: { channel: "client_result", payload: { proofs: [{}], queryResult: mismatch } },
      }),
    );
    expect(failureTag(rejectedExit)).toBe("VerificationProviderRejected");
  });

  test("does not expose unsupported claims or dev mode in production", async () => {
    expect(ZKPASSPORT_MANIFEST.claim_ids).toEqual([
      "age.minimum",
      "credential.subject_unique",
      "document.valid",
      "nationality.allowed",
    ]);
    const result = await Effect.runPromise(
      makeZkPassportProvider(options({ dev_mode: true })).plan({
        ...INPUT,
        environment: "production",
      }),
    );
    expect(result.status).toBe("unsupported");
    expect(ZKPASSPORT_MANIFEST.claim_ids).not.toContain("human.unique");

    const unsupportedCountry = await Effect.runPromise(
      makeZkPassportProvider(options()).plan({
        ...INPUT,
        requested_requirements: [{ claim_id: "nationality.allowed", allowed_countries: ["ZZ"] }],
        requested_claim_ids: ["nationality.allowed"],
      }),
    );
    expect(unsupportedCountry.status).toBe("unsupported");
  });

  test("rejects signed response replay, rebinding, expiry/nonce drift, and MAC tampering", async () => {
    const started = await Effect.runPromise(makeZkPassportProvider(options()).start(INPUT));
    const completeWith = async (result: unknown) =>
      Effect.runPromiseExit(
        makeZkPassportProvider(
          options({ verifier: { verify: () => Effect.succeed(result as never) } }),
        ).complete({
          session: started.session,
          submission: {
            channel: "client_result",
            payload: {
              proofs: [{}],
              queryResult: {
                bind: {
                  custom_data: JSON.stringify({
                    proof_session_id: "session-1",
                    request_hash: HASH,
                  }),
                },
                age: { gte: { expected: 18, result: true } },
                nationality: { in: { expected: ["GEO", "USA"], result: true } },
              },
            },
          },
        }),
      );
    const base = await signedResult({
      domain: "api.example",
      proofs: [{}],
      original_query: {},
      query_result: {},
      validity_seconds: 3600,
      scope: ZKPASSPORT_RP_SCOPE,
      dev_mode: false,
      proof_session_id: started.session.id,
      request_hash: HASH,
      protocol_version: ZKPASSPORT_PROTOCOL_VERSION,
      nonce: NONCE,
      expiry: EXPIRES,
      key_id: RESPONSE_KEY_ID,
    });
    const cases = [
      {
        name: "replay nonce",
        response: await signedResult({ ...base, nonce: "o".repeat(32) } as never, {
          nonce: "o".repeat(32),
        }),
        tag: "VerificationProviderUnboundRejected",
      },
      {
        name: "cross-session",
        response: await signedResult({ ...base, proof_session_id: "other" } as never, {
          proof_session_id: "other",
        }),
        tag: "VerificationProviderUnboundRejected",
      },
      {
        name: "expiry drift",
        response: await signedResult({ ...base, expiry: "2099-01-01T00:30:00.000Z" } as never, {
          expiry: "2099-01-01T00:30:00.000Z",
        }),
        tag: "VerificationProviderUnboundRejected",
      },
      {
        name: "protocol drift",
        response: await signedResult({ ...base, protocol_version: "other" } as never, {
          protocol_version: "other",
        }),
        tag: "VerificationProviderUnboundRejected",
      },
      {
        name: "tampered MAC",
        response: { ...base, unique_identifier: "changed" },
        tag: "VerificationProviderInvalidResponse",
      },
      {
        name: "missing MAC",
        response: { ...base, signature: "" },
        tag: "VerificationProviderInvalidResponse",
      },
    ] as const;
    for (const item of cases) {
      const exit = await completeWith(item.response);
      expect(failureTag(exit), item.name).toBe(item.tag);
    }
  });

  test("rejects a replayed complete response after generating a fresh nonce", async () => {
    const nonces = ["n".repeat(32), "o".repeat(32)];
    let captured: Awaited<ReturnType<typeof signedResult>> | undefined;
    const provider = makeZkPassportProvider(
      options({
        nonce: () => nonces.shift() ?? "p".repeat(32),
        verifier: {
          verify: (input) =>
            Effect.promise(async () => {
              captured ??= await signedResult(input);
              return captured;
            }),
        },
      }),
    );
    const started = await Effect.runPromise(provider.start(INPUT));
    const payload = {
      proofs: [{}],
      queryResult: {
        bind: {
          custom_data: JSON.stringify({ proof_session_id: started.session.id, request_hash: HASH }),
        },
        age: { gte: { expected: 18, result: true } },
        nationality: { in: { expected: ["GEO", "USA"], result: true } },
      },
    };
    await expect(
      Effect.runPromise(
        provider.complete({
          session: started.session,
          submission: { channel: "client_result", payload },
        }),
      ),
    ).resolves.toBeDefined();
    const replay = await Effect.runPromiseExit(
      provider.complete({
        session: started.session,
        submission: { channel: "client_result", payload },
      }),
    );
    expect(failureTag(replay)).toBe("VerificationProviderUnboundRejected");
  });

  test("rejects cross-session response substitution", async () => {
    let firstResponse: Awaited<ReturnType<typeof signedResult>> | undefined;
    const provider = makeZkPassportProvider(
      options({
        verifier: {
          verify: (input) =>
            Effect.promise(async () => {
              firstResponse ??= await signedResult(input);
              return firstResponse;
            }),
        },
      }),
    );
    const first = await Effect.runPromise(provider.start(INPUT));
    const second = await Effect.runPromise(provider.start(INPUT));
    const payloadFor = (sessionId: string) => ({
      proofs: [{}],
      queryResult: {
        bind: { custom_data: JSON.stringify({ proof_session_id: sessionId, request_hash: HASH }) },
        age: { gte: { expected: 18, result: true } },
        nationality: { in: { expected: ["GEO", "USA"], result: true } },
      },
    });
    await Effect.runPromise(
      provider.complete({
        session: first.session,
        submission: { channel: "client_result", payload: payloadFor(first.session.id) },
      }),
    );
    const substituted = await Effect.runPromiseExit(
      provider.complete({
        session: second.session,
        submission: { channel: "client_result", payload: payloadFor(second.session.id) },
      }),
    );
    expect(failureTag(substituted)).toBe("VerificationProviderUnboundRejected");
  });

  test("rejects unsigned, extended, malformed, and field-tampered verifier envelopes", async () => {
    const started = await Effect.runPromise(makeZkPassportProvider(options()).start(INPUT));
    const verifierInput = {
      domain: "api.example",
      proofs: [{}],
      original_query: {},
      query_result: {},
      validity_seconds: 3600,
      scope: ZKPASSPORT_RP_SCOPE,
      dev_mode: false,
      proof_session_id: started.session.id,
      request_hash: HASH,
      protocol_version: ZKPASSPORT_PROTOCOL_VERSION,
      nonce: NONCE,
      expiry: EXPIRES,
      key_id: RESPONSE_KEY_ID,
    } as const;
    const base = await signedResult(verifierInput);
    const completeWith = (result: unknown) =>
      Effect.runPromiseExit(
        makeZkPassportProvider(
          options({ verifier: { verify: () => Effect.succeed(result as never) } }),
        ).complete({
          session: started.session,
          submission: {
            channel: "client_result",
            payload: {
              proofs: [{}],
              queryResult: {
                bind: {
                  custom_data: JSON.stringify({
                    proof_session_id: started.session.id,
                    request_hash: HASH,
                  }),
                },
                age: { gte: { expected: 18, result: true } },
                nationality: { in: { expected: ["GEO", "USA"], result: true } },
              },
            },
          },
        }),
      );
    const mutations = [
      { ...base, proof_session_id: "other-session" },
      { ...base, request_hash: "2".repeat(64) },
      { ...base, verdict: false },
      { ...base, unique_identifier: "other-id" },
      { ...base, unique_identifier_type: null },
      { ...base, protocol_version: "zkpassport-v3" },
      { ...base, nonce: "o".repeat(32) },
      { ...base, expiry: "2099-01-01T00:30:00.000Z" },
      { ...base, key_id: "unknown-key" },
    ];
    for (const mutation of mutations) {
      expect(failureTag(await completeWith(mutation))).toBe("VerificationProviderInvalidResponse");
    }
    const { signature: _signature, ...legacyUnsigned } = base;
    for (const malformed of [
      legacyUnsigned,
      { ...base, signature: "a".repeat(42) },
      { ...base, signature: "a".repeat(43), extra: true },
    ]) {
      expect(failureTag(await completeWith(malformed))).toBe("VerificationProviderInvalidResponse");
    }
  });

  test("rejects validly signed impossible verdict shapes", async () => {
    const started = await Effect.runPromise(makeZkPassportProvider(options()).start(INPUT));
    const queryResult = {
      bind: {
        custom_data: JSON.stringify({ proof_session_id: started.session.id, request_hash: HASH }),
      },
      age: { gte: { expected: 18, result: true } },
      nationality: { in: { expected: ["GEO", "USA"], result: true } },
    };
    const invalidShapes = [
      { verdict: false, unique_identifier: "raw-id", unique_identifier_type: 0 as const },
      { verdict: true, unique_identifier: null, unique_identifier_type: null },
      { verdict: true, unique_identifier: "raw-id", unique_identifier_type: null },
    ] as const;
    for (const shape of invalidShapes) {
      const provider = makeZkPassportProvider(
        options({
          verifier: { verify: (input) => Effect.promise(() => signedResult(input, shape)) },
        }),
      );
      const result = await Effect.runPromiseExit(
        provider.complete({
          session: started.session,
          submission: { channel: "client_result", payload: { proofs: [{}], queryResult } },
        }),
      );
      expect(failureTag(result)).toBe("VerificationProviderInvalidResponse");
    }
  });

  test("accepts a previous response key only inside its explicit grace window", async () => {
    const previous = {
      key_id: "key-2026-07",
      secret: "previous-response-secret",
      valid_until: "2099-01-01T00:30:00.000Z",
    } as const;
    const withPrevious = (now: typeof NOW | "2099-01-01T00:31:00.000Z") =>
      makeZkPassportProvider(
        options({
          clock: { now: () => now, expiresAt: () => EXPIRES },
          previous_verifier_response_signing_key: previous,
          verifier: {
            verify: (input) =>
              Effect.promise(() =>
                signedResult(input, { key_id: previous.key_id }, previous.secret),
              ),
          },
        }),
      );
    const active = withPrevious(NOW);
    const started = await Effect.runPromise(active.start(INPUT));
    const input = {
      session: started.session,
      submission: {
        channel: "client_result" as const,
        payload: {
          proofs: [{}],
          queryResult: {
            bind: {
              custom_data: JSON.stringify({
                proof_session_id: started.session.id,
                request_hash: HASH,
              }),
            },
            age: { gte: { expected: 18, result: true } },
            nationality: { in: { expected: ["GEO", "USA"], result: true } },
          },
        },
      },
    };
    await expect(Effect.runPromise(active.complete(input))).resolves.toBeDefined();
    const expired = await Effect.runPromiseExit(
      withPrevious("2099-01-01T00:31:00.000Z").complete(input),
    );
    expect(failureTag(expired)).toBe("VerificationProviderInvalidResponse");
  });

  test("a verifier false result cannot emit document.valid evidence", async () => {
    let digests = 0;
    const provider = makeZkPassportProvider(
      options({
        digest: {
          digest: () => {
            digests += 1;
            return Effect.succeed("a".repeat(64));
          },
        },
        verifier: {
          verify: (input) =>
            Effect.promise(() =>
              signedResult(input, {
                verdict: false,
                unique_identifier: null,
                unique_identifier_type: null,
              }),
            ),
        },
      }),
    );
    const started = await Effect.runPromise(provider.start(INPUT));
    const result = await Effect.runPromiseExit(
      provider.complete({
        session: started.session,
        submission: {
          channel: "client_result",
          payload: {
            proofs: [{}],
            queryResult: {
              bind: {
                custom_data: JSON.stringify({
                  proof_session_id: started.session.id,
                  request_hash: HASH,
                }),
              },
              age: { gte: { expected: 18, result: true } },
              nationality: { in: { expected: ["GEO", "USA"], result: true } },
            },
          },
        },
      }),
    );
    expect(failureTag(result)).toBe("VerificationProviderUnboundRejected");
    expect(digests).toBe(0);
  });

  test("maps verifier transport timeout/auth/5xx/malformed responses to closed failures", async () => {
    const input = {
      domain: "api.example",
      proofs: [{}],
      original_query: {},
      query_result: {},
      validity_seconds: 3600,
      scope: ZKPASSPORT_RP_SCOPE,
      dev_mode: false,
      proof_session_id: "session-1",
      request_hash: HASH,
      protocol_version: ZKPASSPORT_PROTOCOL_VERSION,
      nonce: NONCE,
      expiry: EXPIRES,
      key_id: RESPONSE_KEY_ID,
    } as const;
    const responseTransport = (response: Response) =>
      makeZkPassportVerifierTransport({
        endpoint: "http://localhost/verify",
        shared_secret: "secret",
        fetcher: async () => response,
      });
    expect(
      failureTag(
        await Effect.runPromiseExit(
          responseTransport(new Response("{}", { status: 401 })).verify(input),
        ),
      ),
    ).toBe("VerificationProviderMisconfigured");
    expect(
      failureTag(
        await Effect.runPromiseExit(
          responseTransport(new Response("{}", { status: 503 })).verify(input),
        ),
      ),
    ).toBe("VerificationProviderUnavailable");
    expect(
      failureTag(
        await Effect.runPromiseExit(
          responseTransport(new Response('{"code":"not_configured"}', { status: 503 })).verify(
            input,
          ),
        ),
      ),
    ).toBe("VerificationProviderMisconfigured");
    for (const body of ["not-json", JSON.stringify({ value: "x".repeat(70 * 1024) })]) {
      expect(
        failureTag(
          await Effect.runPromiseExit(
            responseTransport(new Response(body, { status: 503 })).verify(input),
          ),
        ),
      ).toBe("VerificationProviderUnavailable");
    }
    for (const status of [400, 413]) {
      expect(
        failureTag(
          await Effect.runPromiseExit(
            responseTransport(new Response("{}", { status })).verify(input),
          ),
        ),
      ).toBe("VerificationProviderUnboundRejected");
    }
    expect(
      failureTag(
        await Effect.runPromiseExit(
          responseTransport(new Response("{}", { status: 408 })).verify(input),
        ),
      ),
    ).toBe("VerificationProviderUnavailable");
    expect(
      failureTag(
        await Effect.runPromiseExit(
          responseTransport(
            new Response(JSON.stringify({ value: "x".repeat(70 * 1024) }), { status: 200 }),
          ).verify(input),
        ),
      ),
    ).toBe("VerificationProviderInvalidResponse");
    expect(
      failureTag(
        await Effect.runPromiseExit(
          responseTransport(new Response("{}", { status: 200 })).verify(input),
        ),
      ),
    ).toBe("VerificationProviderInvalidResponse");
    const timeoutTransport = makeZkPassportVerifierTransport({
      endpoint: "http://localhost/verify",
      shared_secret: "secret",
      timeout_ms: 1,
      fetcher: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("timeout", "AbortError")),
          );
        }),
    });
    expect(failureTag(await Effect.runPromiseExit(timeoutTransport.verify(input)))).toBe(
      "VerificationProviderUnavailable",
    );
  });
});
