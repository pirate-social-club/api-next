import { describe, expect, test } from "bun:test";
import type {
  VerificationProviderCompleteInput,
  VerificationProviderStartInput,
} from "@pirate/application/verification";
import { computeVerificationRequestHash } from "@pirate/application/verification";
import { runProviderConformance } from "@pirate/testing/verification";
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
      verify: () =>
        Effect.succeed({
          verified: true,
          unique_identifier: "raw-id",
          unique_identifier_type: 0 as const,
        }),
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
          verify: () => {
            calls += 1;
            return Effect.succeed({
              verified: true,
              unique_identifier: "id",
              unique_identifier_type: 0 as const,
            });
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
          verify: () =>
            Effect.succeed({
              verified: false,
              unique_identifier: null,
              unique_identifier_type: null,
            }),
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

  test("maps verifier transport timeout/auth/5xx/malformed responses to closed failures", async () => {
    const input = {
      domain: "api.example",
      proofs: [{}],
      original_query: {},
      query_result: {},
      validity_seconds: 3600,
      scope: ZKPASSPORT_RP_SCOPE,
      dev_mode: false,
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
