import { describe, expect, test } from "bun:test";
import type {
  VerificationProviderAdapter,
  VerificationProviderCallbackInput,
  VerificationProviderCompleteInput,
  VerificationProviderPlanInput,
  VerificationProviderStartInput,
} from "@pirate/application/verification";
import type { ProofSession, VerificationRequirements } from "@pirate/domain/verification";
import { Cause, Effect, Exit, Result } from "effect";
import { normalizeSelfCountry } from "./self-country-codes.ts";
import {
  makeSelfPassProvider,
  SELF_PASS_MANIFEST,
  SELF_PASS_PROTOCOL_VERSION,
  SELF_PASS_RP_SCOPE,
  type SelfPassAdapterOptions,
  type SelfPassSdk,
  selfPassConfigurationFor,
} from "./self-pass.ts";

const NOW = "2099-08-17T12:00:00.000Z";
const EXPIRES = "2099-08-17T13:00:00.000Z";
const HASH = "2e10fcb51abd84e7edd0541f7f9da0e0f1c0773bc13920b538ca197db3840c42";
const DIGEST = "b".repeat(64);
const CONFIGURATION = selfPassConfigurationFor("https://api.example", true);
const SCOPE = {
  kind: "named" as const,
  scope_semantics: "issuer_rp_scope" as const,
  issuer: SELF_PASS_MANIFEST.provider_id,
  rp_scope: SELF_PASS_RP_SCOPE,
};
const REQUIREMENTS = [
  { claim_id: "age.minimum", minimum_age: "18" },
  { claim_id: "credential.subject_unique" },
  { claim_id: "document.valid" },
  { claim_id: "gender.marker", allowed_markers: ["female", "male"] },
  { claim_id: "nationality.allowed", allowed_countries: ["GE", "US"] },
] as const satisfies VerificationRequirements;
const CLAIM_IDS = [
  "age.minimum",
  "credential.subject_unique",
  "document.valid",
  "gender.marker",
  "nationality.allowed",
] as const;

const START_INPUT: VerificationProviderStartInput = {
  actor_id: "user-1",
  intent_id: "intent-1",
  request_hash: HASH,
  method: "document",
  scope: SCOPE,
  request_mode: "dynamic",
  provider_configuration: CONFIGURATION,
  requested_requirements: REQUIREMENTS,
  requested_claim_ids: CLAIM_IDS,
  subject_binding_intent: "establish",
  protocol_version: SELF_PASS_PROTOCOL_VERSION,
  environment: "test",
};

const PROOF = {
  a: ["1", "2"],
  b: [
    ["3", "4"],
    ["5", "6"],
  ],
  c: ["7", "8"],
};

function identifiers() {
  const counts = new Map<string, number>();
  return {
    next(kind: string) {
      const next = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, next);
      if (kind === "session") return "01234567-89ab-4cde-8012-3456789abcde";
      return `${kind}-${next}`;
    },
  };
}

function selfUserId(requestHash: string): string {
  const chars = requestHash.slice(0, 32).split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16] ?? "8", 16) & 0x3) | 0x8).toString(16);
  return `${chars.slice(0, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}-${chars.slice(16, 20).join("")}-${chars.slice(20).join("")}`;
}

function contextFor(session: ProofSession, hex = true): string {
  const data = JSON.stringify({ proof_session_id: session.id, request_hash: session.request_hash });
  return hex ? `${"0".repeat(128)}${Buffer.from(data).toString("hex")}` : data;
}

function resultFor(session: ProofSession, overrides: Record<string, unknown> = {}) {
  return {
    attestationId: 1,
    isValidDetails: { isValid: true, isMinimumAgeValid: true, isOfacValid: true },
    discloseOutput: {
      nullifier: "self-nullifier-1",
      nationality: "GEO",
      gender: "F",
      expiryDate: "991231",
      minimumAge: "21",
    },
    userData: {
      userIdentifier: selfUserId(session.request_hash),
      userDefinedData: JSON.stringify({
        proof_session_id: session.id,
        request_hash: session.request_hash,
      }),
    },
    ...overrides,
  };
}

class FakeConfigStore {
  readonly config: unknown;
  constructor(config: unknown) {
    this.config = config;
  }
}

class FakeVerifier {
  static readonly constructors: unknown[][] = [];
  static result: unknown;
  constructor(...args: unknown[]) {
    FakeVerifier.constructors.push(args);
  }
  verify() {
    return Promise.resolve(FakeVerifier.result);
  }
}

const SDK = {
  AllIds: new Map(),
  DefaultConfigStore: FakeConfigStore,
  SelfBackendVerifier: FakeVerifier,
} as unknown as SelfPassSdk;

function options(overrides: Partial<SelfPassAdapterOptions> = {}): SelfPassAdapterOptions {
  return {
    callback_origin: "https://api.example",
    app_name: "Pirate",
    mock_passport: true,
    clock: { now: () => NOW, expiresAt: () => EXPIRES },
    identifiers: identifiers(),
    digest: { digest: () => Effect.succeed(DIGEST) },
    sdk: SDK,
    ...overrides,
  };
}

function provider(overrides: Partial<SelfPassAdapterOptions> = {}): VerificationProviderAdapter {
  return makeSelfPassProvider(options(overrides));
}

function planInput(overrides: Partial<VerificationProviderPlanInput> = {}) {
  return {
    method: START_INPUT.method,
    scope: START_INPUT.scope,
    requested_requirements: START_INPUT.requested_requirements,
    requested_claim_ids: START_INPUT.requested_claim_ids,
    subject_binding_intent: START_INPUT.subject_binding_intent,
    protocol_version: START_INPUT.protocol_version,
    environment: START_INPUT.environment,
    ...overrides,
  } satisfies VerificationProviderPlanInput;
}

async function failureTag(effect: Effect.Effect<unknown, unknown>): Promise<string> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected failure");
  const failure = Cause.findError(exit.cause);
  if (Result.isFailure(failure)) throw new Error("expected typed failure");
  return String((failure.success as { readonly _tag?: unknown })._tag);
}

async function started(adapter = provider()) {
  return Effect.runPromise(adapter.start(START_INPUT));
}

function completionInput(
  session: ProofSession,
  payload: unknown,
): VerificationProviderCompleteInput {
  return {
    session,
    submission: { channel: "client_result", payload },
  };
}

describe("Self Pass provider-local adapter", () => {
  test("normalizes the canonical Self country table and rejects unknown values", () => {
    expect(normalizeSelfCountry("GEO")).toBe("GE");
    expect(normalizeSelfCountry("USA")).toBe("US");
    expect(normalizeSelfCountry("MEX")).toBe("MX");
    expect(normalizeSelfCountry("ROU")).toBe("RO");
    expect(normalizeSelfCountry("RUS")).toBe("RU");
    expect(normalizeSelfCountry("RWA")).toBe("RW");
    expect(normalizeSelfCountry("TKL")).toBe("TK");
    expect(normalizeSelfCountry("TTO")).toBe("TT");
    expect(normalizeSelfCountry("  geo ")).toBe("GE");
    expect(normalizeSelfCountry("ZZZ")).toBeUndefined();
    expect(normalizeSelfCountry("ZZ")).toBeUndefined();
  });

  test("plans only canonical dynamic requests and rejects holder binding", async () => {
    await expect(Effect.runPromise(provider().plan(planInput()))).resolves.toEqual({
      status: "supported",
      request_mode: "dynamic",
      provider_configuration: CONFIGURATION,
    });
    await expect(
      Effect.runPromise(
        provider().plan(
          planInput({
            requested_requirements: [{ claim_id: "document.holder_bound" }],
            requested_claim_ids: ["document.holder_bound"],
          }),
        ),
      ),
    ).resolves.toEqual({ status: "unsupported" });
    await expect(
      Effect.runPromise(
        provider().plan(planInput({ scope: { ...SCOPE, rp_scope: "other-scope" } })),
      ),
    ).resolves.toEqual({ status: "unsupported" });
  });

  test("compiles launch disclosures and binds the fixed endpoint, scope, and request hash", async () => {
    const startedSession = await started();
    expect(startedSession.presentation).toMatchObject({
      kind: "embedded_sdk",
      protocol: "self",
      version: "2",
      payload: {
        endpoint: "https://api.example/verification/callbacks/self.pass",
        endpoint_type: "staging_https",
        scope: SELF_PASS_RP_SCOPE,
        user_id_type: "uuid",
        disclosures: { minimum_age: 18, nationality: true, gender: true },
        dev_mode: true,
        version: 2,
      },
    });
    expect(startedSession.session.upstream_session_ref).toBe(startedSession.session.id);
    expect(JSON.stringify(startedSession.session.upstream_session_ref)).not.toContain("minimumAge");
    expect(startedSession.session.started_at).toBe(NOW);
    expect(startedSession.session.expires_at).toBe(EXPIRES);
  });

  test("uses explicit mock mode and never permits it for production", async () => {
    const realStaging = await Effect.runPromise(
      provider({ mock_passport: false }).start({
        ...START_INPUT,
        environment: "staging",
        provider_configuration: selfPassConfigurationFor("https://api.example", false),
      }),
    );
    if (realStaging.presentation.kind !== "embedded_sdk") {
      throw new Error("expected embedded Self presentation");
    }
    expect(realStaging.presentation.payload).toMatchObject({
      endpoint_type: "https",
      dev_mode: false,
    });
    const mockedStaging = await Effect.runPromise(
      provider({ mock_passport: true }).start({ ...START_INPUT, environment: "staging" }),
    );
    if (mockedStaging.presentation.kind !== "embedded_sdk") {
      throw new Error("expected embedded Self presentation");
    }
    expect(mockedStaging.presentation.payload).toMatchObject({ dev_mode: true });
    await expect(
      Effect.runPromise(
        provider({ mock_passport: true }).plan(planInput({ environment: "production" })),
      ),
    ).resolves.toEqual({ status: "unsupported" });
    await expect(
      failureTag(
        provider({ mock_passport: true }).start({ ...START_INPUT, environment: "production" }),
      ),
    ).resolves.toBe("VerificationProviderRejected");
    await expect(
      Effect.runPromise(
        provider({ mock_passport: false }).plan(planInput({ environment: "production" })),
      ),
    ).resolves.toMatchObject({ status: "supported" });
    await expect(Effect.runPromise(provider({ app_name: " " }).plan(planInput()))).resolves.toEqual(
      { status: "unsupported" },
    );
    await expect(
      Effect.runPromise(provider({ app_name: "x".repeat(129) }).plan(planInput())),
    ).resolves.toEqual({ status: "unsupported" });
  });

  test("reconstructs endpoint and verifier mode from the immutable session ref", async () => {
    FakeVerifier.constructors.length = 0;
    const oldOrigin = "https://old-api.example";
    const oldAdapter = provider({ callback_origin: oldOrigin, mock_passport: true });
    const oldSession = await Effect.runPromise(
      oldAdapter.start({
        ...START_INPUT,
        provider_configuration: selfPassConfigurationFor(oldOrigin, true),
      }),
    );
    FakeVerifier.result = resultFor(oldSession.session);
    const redeployedAdapter = provider({
      callback_origin: "https://new-api.example",
      mock_passport: false,
    });
    await Effect.runPromise(
      redeployedAdapter.complete(
        completionInput(oldSession.session, {
          kind: "self-proof",
          session_id: oldSession.session.id,
          attestation_id: 1,
          proof: PROOF,
          public_signals: ["1"],
          user_context_data: contextFor(oldSession.session),
        }),
      ),
    );
    expect(FakeVerifier.constructors[0]?.slice(0, 3)).toEqual([
      SELF_PASS_RP_SCOPE,
      `${oldOrigin}/verification/callbacks/self.pass`,
      true,
    ]);
  });

  test("resolves callback structure without claiming cryptographic authentication", async () => {
    const session = await started();
    const payload = {
      kind: "self-proof",
      attestationId: 1,
      proof: PROOF,
      publicSignals: ["1"],
      userContextData: contextFor(session.session),
    };
    const callback: VerificationProviderCallbackInput = {
      raw_body: JSON.stringify(payload),
      headers: {},
    };
    const resolution = await Effect.runPromise(
      provider().resolveCallback?.(callback) ?? Effect.die("missing callback"),
    );
    expect(resolution.proof_session_id).toBe(session.session.id);
    expect(resolution.idempotency_key).toBe(DIGEST);
    expect(resolution.submission.channel).toBe("provider_callback");
    expect(resolution.submission.payload).toEqual(payload);
  });

  test("rejects callback context without a high-entropy session binding", async () => {
    const payload = {
      kind: "self-proof",
      attestationId: 1,
      proof: PROOF,
      publicSignals: ["1"],
      userContextData: `${"0".repeat(128)}${Buffer.from(JSON.stringify({ proof_session_id: "short", request_hash: HASH })).toString("hex")}`,
    };
    const callback: VerificationProviderCallbackInput = {
      raw_body: JSON.stringify(payload),
      headers: {},
    };
    await expect(
      failureTag(provider().resolveCallback?.(callback) ?? Effect.die("missing callback")),
    ).resolves.toBe("VerificationProviderRejected");
  });

  test("constructs the pinned verifier from immutable session requirements and maps evidence", async () => {
    FakeVerifier.constructors.length = 0;
    const adapter = provider();
    const session = await started(adapter);
    FakeVerifier.result = resultFor(session.session, {
      userData: {
        userIdentifier: selfUserId(session.session.request_hash),
        userDefinedData: Buffer.from(
          JSON.stringify({
            proof_session_id: session.session.id,
            request_hash: session.session.request_hash,
          }),
        ).toString("hex"),
      },
    });
    const payload = {
      kind: "self-proof",
      session_id: session.session.id,
      attestation_id: 1,
      proof: PROOF,
      public_signals: ["1"],
      user_context_data: contextFor(session.session),
    };
    const bundle = await Effect.runPromise(
      adapter.complete(completionInput(session.session, payload)),
    );
    const constructorArgs = FakeVerifier.constructors[0] ?? [];
    expect(constructorArgs.slice(0, 3)).toEqual([
      SELF_PASS_RP_SCOPE,
      "https://api.example/verification/callbacks/self.pass",
      true,
    ]);
    expect((constructorArgs[4] as FakeConfigStore).config).toEqual({ minimumAge: 18 });
    expect(bundle.receipts[0]?.evidence_kind).toBe("self.pass.attestation.1");
    expect(bundle.receipts[0]?.metadata).toEqual({
      credential_type: "passport",
      source_attestation_id: "1",
    });
    expect(bundle.receipts[0]?.provider_configuration).toEqual(CONFIGURATION);
    expect(bundle.receipts[0]?.scope).toEqual(SCOPE);
    expect(bundle.assertions.map((assertion) => assertion.claim_id)).toEqual([...CLAIM_IDS]);
    expect(
      bundle.assertions.find((assertion) => assertion.claim_id === "nationality.allowed")?.value,
    ).toEqual({ allowed: true });
    expect(bundle.assertions.some((assertion) => assertion.claim_id === "human.unique")).toBe(
      false,
    );
    expect(
      bundle.assertions.some((assertion) => assertion.claim_id === "document.holder_bound"),
    ).toBe(false);
  });

  test("requires a current document expiry and accepts Aadhaar's explicit no-expiry form", async () => {
    const adapter = provider();
    const start = await Effect.runPromise(
      adapter.start({
        ...START_INPUT,
        requested_requirements: [
          { claim_id: "credential.subject_unique" },
          { claim_id: "document.valid" },
        ],
        requested_claim_ids: ["credential.subject_unique", "document.valid"],
      }),
    );
    const passportPayload = {
      kind: "self-proof",
      session_id: start.session.id,
      attestation_id: 1,
      proof: PROOF,
      public_signals: ["1"],
      user_context_data: contextFor(start.session),
    };
    FakeVerifier.result = resultFor(start.session, {
      discloseOutput: {
        ...resultFor(start.session).discloseOutput,
        expiryDate: "980101",
      },
    });
    await expect(
      failureTag(adapter.complete(completionInput(start.session, passportPayload))),
    ).resolves.toBe("VerificationProviderRejected");

    FakeVerifier.result = resultFor(start.session, {
      attestationId: 3,
      discloseOutput: {
        ...resultFor(start.session).discloseOutput,
        nationality: "IND",
        expiryDate: "UNAVAILABLE",
      },
    });
    const aadhaar = await Effect.runPromise(
      adapter.complete(completionInput(start.session, { ...passportPayload, attestation_id: 3 })),
    );
    expect(aadhaar.receipts[0]?.metadata).toEqual({
      credential_type: "aadhaar",
      source_attestation_id: "3",
    });
  });

  test("rejects a cryptographically invalid result and cross-session context", async () => {
    const adapter = provider();
    const session = await started(adapter);
    FakeVerifier.result = resultFor(session.session, {
      isValidDetails: { isValid: false, isMinimumAgeValid: false, isOfacValid: true },
    });
    const payload = {
      kind: "self-proof",
      session_id: session.session.id,
      attestation_id: 1,
      proof: PROOF,
      public_signals: ["1"],
      user_context_data: contextFor(session.session),
    };
    await expect(
      failureTag(adapter.complete(completionInput(session.session, payload))),
    ).resolves.toBe("VerificationProviderRejected");
    FakeVerifier.result = resultFor(session.session, {
      discloseOutput: {
        ...resultFor(session.session).discloseOutput,
        nationality: "RUS",
      },
    });
    await expect(
      failureTag(adapter.complete(completionInput(session.session, payload))),
    ).resolves.toBe("VerificationProviderRejected");
    FakeVerifier.result = resultFor(session.session, {
      isValidDetails: { isValid: true, isMinimumAgeValid: false, isOfacValid: true },
    });
    await expect(
      failureTag(adapter.complete(completionInput(session.session, payload))),
    ).resolves.toBe("VerificationProviderRejected");
    FakeVerifier.result = resultFor(session.session, {
      userData: {
        userIdentifier: selfUserId(session.session.request_hash),
        userDefinedData: JSON.stringify({
          proof_session_id: session.session.id,
          request_hash: "a".repeat(64),
        }),
      },
    });
    await expect(
      failureTag(adapter.complete(completionInput(session.session, payload))),
    ).resolves.toBe("VerificationProviderRejected");
  });
});
