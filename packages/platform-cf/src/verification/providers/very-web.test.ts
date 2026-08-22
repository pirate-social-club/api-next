import { describe, expect, test } from "bun:test";
import type {
  VerificationProviderCompleteInput,
  VerificationProviderPlanInput,
  VerificationProviderStartInput,
} from "@pirate/application/verification";
import type { ProofSession, VerificationRequirements } from "@pirate/domain/verification";
import { Cause, Effect, Exit, Result } from "effect";
import {
  makeVeryWebFetchTransport,
  makeVeryWebProvider,
  VERY_WEB_CONFIGURATION_REFERENCE,
  VERY_WEB_CONFIGURATION_VERSION,
  VERY_WEB_HTTP_TIMEOUT_MS,
  VERY_WEB_ISSUER,
  VERY_WEB_MANIFEST,
  VERY_WEB_MAX_RESPONSE_BYTES,
  VERY_WEB_METHOD,
  VERY_WEB_PROTOCOL_VERSION,
  VERY_WEB_PROVIDER_ID,
  VERY_WEB_RP_SCOPE,
  type VeryWebAdapterOptions,
  type VeryWebTransport,
} from "./very-web.ts";

const NOW = "2099-08-20T12:00:00.000Z";
const EXPIRES = "2099-08-20T12:05:00.000Z";
const HASH = "d628ee9079970681ece2757f9a269054129a0382f66fad34102cddcd7dbc9cc5";
const DIGEST = "b".repeat(64);
const KEY = new Uint8Array(32).fill(7);
const BN128_SCALAR_FIELD =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const CONTEXT_ID = "1034873066642566601948846461572930273212113570698";
const CREATION_EXTERNAL_NULLIFIER = "1351226003881404976665755614907410091657079916364";
const JOIN_EXTERNAL_NULLIFIER = "264217990274801941962267316944909823304321904290";
const PROOF_EXTERNAL_NULLIFIERS: Readonly<Record<string, string>> = {
  [CREATION_EXTERNAL_NULLIFIER]:
    "7114467325980480031640335257048686324528067571390309514628619251716905169257",
  [JOIN_EXTERNAL_NULLIFIER]:
    "16908375590427872095478225792601985971283130407532372051473232178944199924789",
};

const SCOPE = {
  kind: "named" as const,
  scope_semantics: "issuer_rp_scope" as const,
  issuer: VERY_WEB_ISSUER,
  rp_scope: VERY_WEB_RP_SCOPE,
};
const REQUIREMENTS = [
  { claim_id: "credential.subject_unique" },
  { claim_id: "human.personhood" },
] as const satisfies VerificationRequirements;
const CLAIM_IDS = ["credential.subject_unique", "human.personhood"] as const;
const CONFIGURATION = {
  kind: "dynamic" as const,
  reference: VERY_WEB_CONFIGURATION_REFERENCE,
  version: VERY_WEB_CONFIGURATION_VERSION,
};
const START_INPUT: VerificationProviderStartInput = {
  actor_id: "actor-1",
  intent_id: "intent-1",
  request_hash: HASH,
  method: VERY_WEB_METHOD,
  scope: SCOPE,
  request_mode: "dynamic",
  provider_configuration: CONFIGURATION,
  requested_requirements: REQUIREMENTS,
  requested_claim_ids: CLAIM_IDS,
  subject_binding_intent: "establish",
  protocol_version: VERY_WEB_PROTOCOL_VERSION,
  environment: "test",
  verification_purpose: {
    intent: "community_join",
    policy_id: "curated-human-membership-v1",
  },
};

type Calls = {
  readonly create: Array<Readonly<{ url: string; body: string; timeout_ms: number }>>;
  readonly bridge: Array<Readonly<{ url: string; session_id: string; timeout_ms: number }>>;
  readonly verify: Array<Readonly<{ url: string; proof: string; timeout_ms: number }>>;
};

function identifiers() {
  const counts = new Map<string, number>();
  return {
    next(kind: string) {
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      return `${kind}-${next}`;
    },
  };
}

function randomness() {
  let calls = 0;
  return {
    bytes(length: number) {
      calls += 1;
      return new Uint8Array(length).fill(calls);
    },
  };
}

function transportWith(
  calls: Calls,
  bridgeBody: unknown | (() => unknown) = { status: "pending" },
): VeryWebTransport {
  return {
    createBridge: (input) => {
      calls.create.push({ url: input.url, body: input.body, timeout_ms: input.timeout_ms });
      return Effect.succeed({ status: 200, body: { sessionId: "bridge-session-1" } });
    },
    bridgeStatus: (input) => {
      calls.bridge.push(input);
      return Effect.succeed({
        status: 200,
        body: typeof bridgeBody === "function" ? bridgeBody() : bridgeBody,
      });
    },
    verify: (input) => {
      calls.verify.push(input);
      return Effect.succeed({
        status: 200,
        body: { status: "valid" },
      });
    },
  };
}

function options(overrides: Partial<VeryWebAdapterOptions> = {}) {
  const calls: Calls = { create: [], bridge: [], verify: [] };
  const base: VeryWebAdapterOptions = {
    app_id: "very-app",
    api_url: "https://api.very.example/api/v1",
    verify_url: "https://verify.very.example/api/v1/verify",
    bridge_api_url: "https://bridge.very.example/api/v1",
    sealing_key: KEY,
    transport: transportWith(calls),
    clock: { now: () => NOW, expiresAt: () => EXPIRES },
    identifiers: identifiers(),
    randomness: randomness(),
    digest: { digest: () => Effect.succeed(DIGEST) },
  };
  return { value: { ...base, ...overrides }, calls };
}

function planInput(
  overrides: Partial<VerificationProviderPlanInput> = {},
): VerificationProviderPlanInput {
  return {
    method: START_INPUT.method,
    scope: START_INPUT.scope,
    requested_requirements: START_INPUT.requested_requirements,
    requested_claim_ids: START_INPUT.requested_claim_ids,
    subject_binding_intent: START_INPUT.subject_binding_intent,
    protocol_version: START_INPUT.protocol_version,
    environment: START_INPUT.environment,
    verification_purpose: START_INPUT.verification_purpose,
    ...overrides,
  };
}

async function failureTag(effect: Effect.Effect<unknown, unknown>): Promise<string> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (Result.isFailure(failure)) throw new Error("expected typed failure");
  return String((failure.success as { readonly _tag?: unknown })._tag);
}

async function started(adapter: ReturnType<typeof makeVeryWebProvider>) {
  return Effect.runPromise(adapter.start(START_INPUT));
}

function complete(session: ProofSession, payload: unknown): VerificationProviderCompleteInput {
  return { session, submission: { channel: "client_result", payload } };
}

function presentationQuery(start: Awaited<ReturnType<typeof started>>) {
  if (start.presentation.kind !== "embedded_sdk") {
    throw new Error("expected embedded presentation");
  }
  const payload = start.presentation.payload;
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("expected embedded payload object");
  }
  const encodedQuery = (payload as Record<string, unknown>).query;
  if (typeof encodedQuery !== "string") throw new Error("expected serialized query");
  return JSON.parse(encodedQuery) as {
    readonly conditions: readonly [
      Readonly<{
        readonly value: Readonly<{ readonly from: string; readonly to: string }>;
      }>,
    ];
    readonly options: Readonly<{
      readonly expiredAtLowerBound: string;
      readonly externalNullifier: string;
      readonly equalCheckId: string;
      readonly pseudonym: string;
    }>;
  };
}

function proofFor(
  start: Awaited<ReturnType<typeof started>>,
  signalOverrides: Readonly<Record<number, string>> = {},
): string {
  const query = presentationQuery(start);
  const proofExternalNullifier = PROOF_EXTERNAL_NULLIFIERS[query.options.externalNullifier];
  if (proofExternalNullifier === undefined) {
    throw new Error("missing proof external-nullifier fixture");
  }
  const publicSignals = [
    "3",
    CONTEXT_ID,
    "101",
    proofExternalNullifier,
    query.options.pseudonym,
    query.options.expiredAtLowerBound,
    "202",
    query.options.equalCheckId,
    query.conditions[0].value.from,
    query.conditions[0].value.to,
  ];
  for (const [index, value] of Object.entries(signalOverrides)) {
    publicSignals[Number(index)] = value;
  }
  return JSON.stringify({
    proof: {
      pi_a: ["1", "2", "1"],
      pi_b: [
        ["3", "4"],
        ["5", "6"],
        ["1", "0"],
      ],
      pi_c: ["7", "8", "1"],
      protocol: "groth16",
      curve: "bn128",
    },
    publicSignals,
  });
}

describe("Very web provider", () => {
  test("advertises the widget/bridge contract without human.unique", async () => {
    const configured = options();
    const adapter = makeVeryWebProvider(configured.value);
    expect(VERY_WEB_MANIFEST.provider_id).toBe("very.web");
    expect(VERY_WEB_MANIFEST.supported_methods).toEqual(["palm_web"]);
    expect(VERY_WEB_MANIFEST.presentation_kinds).toEqual(["embedded_sdk"]);
    expect(VERY_WEB_MANIFEST.claim_ids).not.toContain("human.unique");
    expect(await Effect.runPromise(adapter.plan(planInput()))).toEqual({
      status: "supported",
      request_mode: "dynamic",
      provider_configuration: CONFIGURATION,
    });
  });

  test("starts a server-bound bridge and exposes only launch data", async () => {
    const configured = options();
    const start = await started(makeVeryWebProvider(configured.value));
    expect(configured.calls.create).toHaveLength(1);
    expect(configured.calls.create[0]?.timeout_ms).toBe(VERY_WEB_HTTP_TIMEOUT_MS);
    expect(start.session).toMatchObject({
      provider_id: VERY_WEB_PROVIDER_ID,
      status: "pending",
      started_at: NOW,
      expires_at: EXPIRES,
    });
    expect(start.session.upstream_session_ref).toMatch(/^very\.web\.v1\./u);
    expect(start.presentation.kind).toBe("embedded_sdk");
    if (start.presentation.kind !== "embedded_sdk")
      throw new Error("expected embedded presentation");
    expect(start.presentation.payload).toMatchObject({
      app_id: "very-app",
      mobile: { uri: expect.stringContaining("veros://verify") },
    });
    expect(JSON.stringify(start.presentation)).not.toContain("777");
  });

  test("uses stable field-safe external nullifiers and fresh field-safe pseudonyms", async () => {
    const configured = options();
    const adapter = makeVeryWebProvider(configured.value);
    const first = await Effect.runPromise(adapter.start(START_INPUT));
    const second = await Effect.runPromise(
      adapter.start({
        ...START_INPUT,
        intent_id: "intent-2",
        request_hash: "e".repeat(64),
      }),
    );

    const firstQuery = presentationQuery(first);
    const secondQuery = presentationQuery(second);
    expect(first.presentation).toMatchObject({
      payload: { context: "VeryAI - Palm Verification Timestamp" },
    });
    expect(firstQuery.options.externalNullifier).toBe(JOIN_EXTERNAL_NULLIFIER);
    expect(secondQuery.options.externalNullifier).toBe(firstQuery.options.externalNullifier);
    for (const value of [firstQuery.options.externalNullifier, firstQuery.options.pseudonym]) {
      expect(value).toMatch(/^[1-9][0-9]*$/u);
      expect(BigInt(value)).toBeLessThan(BN128_SCALAR_FIELD);
    }
    expect(secondQuery.options.pseudonym).not.toBe(firstQuery.options.pseudonym);

    const creation = await Effect.runPromise(
      adapter.start({
        ...START_INPUT,
        intent_id: "creation-intent",
        request_hash: "f".repeat(64),
        verification_purpose: { intent: "community_creation" },
      }),
    );
    expect(presentationQuery(creation).options.externalNullifier).toBe(CREATION_EXTERNAL_NULLIFIER);
  });

  test("rejects a zero pseudonym before creating a bridge session", async () => {
    const calls: Calls = { create: [], bridge: [], verify: [] };
    const configured = options({
      transport: transportWith(calls),
      randomness: {
        bytes: (length) =>
          length === 31 ? new Uint8Array(length) : new Uint8Array(length).fill(1),
      },
    });
    expect(await failureTag(makeVeryWebProvider(configured.value).start(START_INPUT))).toBe(
      "VerificationProviderInvalidResponse",
    );
    expect(calls.create).toHaveLength(0);
  });

  test("verifies a desktop widget proof server-side and mints scoped evidence", async () => {
    const digested: string[] = [];
    const configured = options({
      digest: {
        digest: (value) => {
          digested.push(value);
          return Effect.succeed(DIGEST);
        },
      },
    });
    const adapter = makeVeryWebProvider(configured.value);
    const start = await started(adapter);
    const proof = proofFor(start);
    const result = await Effect.runPromise(
      adapter.complete(complete(start.session, { mode: "widget", proof })),
    );
    expect(configured.calls.verify).toEqual([
      {
        url: configured.value.verify_url,
        proof,
        timeout_ms: VERY_WEB_HTTP_TIMEOUT_MS,
      },
    ]);
    expect(result.assertions.map((assertion) => assertion.claim_id)).toEqual([...CLAIM_IDS]);
    expect(result.subject_keys[0]?.scope).toEqual(SCOPE);
    expect(digested[0]).toBe("101");
    expect(JSON.stringify(result)).not.toContain(proof);
  });

  test("accepts only the captured top-level verifier status contract", async () => {
    const cases = [
      {
        body: null,
        expected: "VerificationProviderInvalidResponse",
      },
      {
        body: {},
        expected: "VerificationProviderInvalidResponse",
      },
      {
        body: { valid: true },
        expected: "VerificationProviderInvalidResponse",
      },
      {
        body: { status: "pending" },
        expected: "VerificationProviderUnavailable",
      },
      {
        body: { status: "failed" },
        expected: "VerificationProviderRejected",
      },
    ] as const;

    for (const testCase of cases) {
      const configured = options({
        transport: {
          ...transportWith({ create: [], bridge: [], verify: [] }),
          verify: () => Effect.succeed({ status: 200, body: testCase.body }),
        },
      });
      const adapter = makeVeryWebProvider(configured.value);
      const start = await started(adapter);
      expect(
        await failureTag(
          adapter.complete(complete(start.session, { mode: "widget", proof: proofFor(start) })),
        ),
      ).toBe(testCase.expected);
    }
  });

  test("rejects malformed or mismatched proof public signals before verification", async () => {
    const mismatches = [
      { index: 0, value: "4" },
      { index: 1, value: "1" },
      { index: 2, value: "0" },
      { index: 3, value: "1" },
      { index: 4, value: "1" },
      { index: 5, value: "1" },
      { index: 7, value: "2" },
      { index: 8, value: "1" },
      { index: 9, value: "1" },
    ] as const;

    for (const mismatch of mismatches) {
      const configured = options();
      const adapter = makeVeryWebProvider(configured.value);
      const start = await started(adapter);
      expect(
        await failureTag(
          adapter.complete(
            complete(start.session, {
              mode: "widget",
              proof: proofFor(start, { [mismatch.index]: mismatch.value }),
            }),
          ),
        ),
      ).toMatch(/^VerificationProvider(?:InvalidResponse|Rejected)$/u);
      expect(configured.calls.verify).toHaveLength(0);
    }

    const configured = options();
    const adapter = makeVeryWebProvider(configured.value);
    const start = await started(adapter);
    expect(
      await failureTag(
        adapter.complete(complete(start.session, { mode: "widget", proof: "not-json" })),
      ),
    ).toBe("VerificationProviderInvalidResponse");
    expect(configured.calls.verify).toHaveLength(0);
  });

  test("accepts either encoded equality bit for equal-check id zero", async () => {
    for (const equalityBit of ["0", "1"] as const) {
      const configured = options();
      const adapter = makeVeryWebProvider(configured.value);
      const start = await started(adapter);
      const result = await Effect.runPromise(
        adapter.complete(
          complete(start.session, { mode: "widget", proof: proofFor(start, { 7: equalityBit }) }),
        ),
      );
      expect(result.assertions).toHaveLength(2);
    }
  });

  test("rejects terminal-session replay before any provider transport call", async () => {
    const configured = options();
    const adapter = makeVeryWebProvider(configured.value);
    const start = await started(adapter);
    const terminalSession = { ...start.session, status: "completed" as const };

    expect(
      await failureTag(
        adapter.complete(complete(terminalSession, { mode: "widget", proof: "replayed-proof" })),
      ),
    ).toBe("VerificationProviderUnboundRejected");
    expect(configured.calls.bridge).toHaveLength(0);
    expect(configured.calls.verify).toHaveLength(0);
  });

  test("decrypts the mobile bridge result on the server before verification", async () => {
    let bridgeBody: unknown = { status: "pending" };
    const calls: Calls = { create: [], bridge: [], verify: [] };
    const configured = options({ transport: transportWith(calls, () => bridgeBody) });
    const adapter = makeVeryWebProvider(configured.value);
    const start = await started(adapter);
    if (start.presentation.kind !== "embedded_sdk")
      throw new Error("expected embedded presentation");
    const embeddedPayload = start.presentation.payload;
    if (
      embeddedPayload === null ||
      typeof embeddedPayload !== "object" ||
      Array.isArray(embeddedPayload)
    ) {
      throw new Error("expected embedded payload object");
    }
    const mobile = (embeddedPayload as Record<string, unknown>).mobile as { uri: string };
    const url = new URL(mobile.uri);
    const key = Uint8Array.from(atob(url.searchParams.get("key") ?? ""), (character) =>
      character.charCodeAt(0),
    );
    const iv = new Uint8Array(12).fill(9);
    const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["encrypt"]);
    const proof = proofFor(start);
    const payload = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cryptoKey,
        new TextEncoder().encode(proof),
      ),
    );
    bridgeBody = {
      status: "completed",
      response: {
        iv: btoa(String.fromCharCode(...iv)),
        payload: btoa(String.fromCharCode(...payload)),
      },
    };
    const result = await Effect.runPromise(
      adapter.complete(complete(start.session, { mode: "bridge" })),
    );
    expect(calls.bridge).toHaveLength(1);
    expect(calls.verify[0]?.proof).toBe(proof);
    expect(result.assertions).toHaveLength(2);
  });

  test("rejects a verified proof without the persisted binding", async () => {
    const configured = options();
    const adapter = makeVeryWebProvider(configured.value);
    const start = await started(adapter);
    expect(
      await failureTag(
        adapter.complete(
          complete(start.session, { mode: "widget", proof: proofFor(start, { 4: "9" }) }),
        ),
      ),
    ).toBe("VerificationProviderRejected");
  });

  test("rejects undocumented verifier success aliases", async () => {
    const candidates = [
      { valid: true },
      { verified: true },
      { status: "verified" },
      { status: "VALID" },
      { result: true },
    ] as const;

    for (const body of candidates) {
      const configured = options({
        transport: {
          ...transportWith({ create: [], bridge: [], verify: [] }),
          verify: () => Effect.succeed({ status: 200, body }),
        },
      });
      const adapter = makeVeryWebProvider(configured.value);
      const start = await started(adapter);
      expect(
        await failureTag(
          adapter.complete(complete(start.session, { mode: "widget", proof: proofFor(start) })),
        ),
      ).toMatch(/^VerificationProvider(?:InvalidResponse|Rejected)$/u);
    }
  });

  test("bounds fetch responses before JSON parsing", async () => {
    const transport = makeVeryWebFetchTransport(
      async () =>
        new Response("x".repeat(VERY_WEB_MAX_RESPONSE_BYTES + 1), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    expect(
      await failureTag(
        transport.verify({
          url: "https://verify.very.example/api/v1/verify",
          proof: "opaque",
          timeout_ms: VERY_WEB_HTTP_TIMEOUT_MS,
        }),
      ),
    ).toBe("VerificationProviderInvalidResponse");
  });

  test("fails closed for pending, mismatched, and malformed provider results", async () => {
    const pending = options({
      transport: transportWith({ create: [], bridge: [], verify: [] }, { status: "pending" }),
    });
    const pendingAdapter = makeVeryWebProvider(pending.value);
    const pendingStart = await started(pendingAdapter);
    expect(
      await failureTag(pendingAdapter.complete(complete(pendingStart.session, { mode: "bridge" }))),
    ).toBe("VerificationProviderUnavailable");

    const mismatchCalls: Calls = { create: [], bridge: [], verify: [] };
    const mismatch = options({ transport: transportWith(mismatchCalls) });
    const mismatchAdapter = makeVeryWebProvider(mismatch.value);
    const mismatchStart = await started(mismatchAdapter);
    expect(
      await failureTag(
        mismatchAdapter.complete(
          complete(mismatchStart.session, {
            mode: "widget",
            proof: proofFor(mismatchStart, { 4: "9" }),
          }),
        ),
      ),
    ).toBe("VerificationProviderRejected");
    expect(
      await failureTag(
        mismatchAdapter.complete(
          complete(mismatchStart.session, {
            mode: "widget",
            proof: proofFor(mismatchStart),
            extra: true,
          }),
        ),
      ),
    ).toBe("VerificationProviderUnboundRejected");
  });
});
