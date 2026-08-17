import { describe, expect, test } from "bun:test";
import {
  makeVerificationProviderRegistry,
  VerificationProviderInvalidResponse,
  VerificationProviderManifestInvalid,
  VerificationProviderMisconfigured,
  type VerificationProviderPlanInput,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
  VerificationProviderUnavailable,
  validateProofProviderManifest,
} from "@pirate/application/verification";
import { Cause, Effect, Exit, Result } from "effect";
import type { FakeProviderMode } from "./fake-provider.ts";
import {
  FAKE_PROVIDER_MANIFEST,
  type FakeProviderTransport,
  makeFakeVerificationProvider,
  makeFakeVerificationTransport,
  NO_SUBJECT_FAKE_PROVIDER_MANIFEST,
} from "./fake-provider.ts";
import { runProviderConformance, runProviderTransportConformance } from "./provider-conformance.ts";

const FAKE_START_INPUT: VerificationProviderStartInput = {
  actor_id: "user-1",
  intent_id: "intent-1",
  request_hash: "1029e84626c1879aedec7f8c4c604f8265206ecc2f40c08f177591d3e8c14252",
  method: "document",
  scope: {
    kind: "named",
    issuer: "test.fake",
    rp_scope: "test-rp",
    scope_semantics: "issuer_rp_scope",
  },
  request_mode: "dynamic",
  requested_requirements: [
    { claim_id: "credential.subject_unique" },
    { claim_id: "document.valid" },
  ],
  requested_claim_ids: ["credential.subject_unique", "document.valid"],
  subject_binding_intent: "establish",
  protocol_version: "fake-v2",
  environment: "test",
};

function failureOf<A, E>(exit: Exit.Exit<A, E>): E | undefined {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.findError(exit.cause);
  return Result.isSuccess(failure) ? failure.success : undefined;
}

async function registered(mode?: FakeProviderMode) {
  return Effect.runPromise(
    makeVerificationProviderRegistry([
      makeFakeVerificationProvider(mode === undefined ? {} : { mode }),
    ]),
  );
}

interface RecordedFakeTransport extends FakeProviderTransport {
  readonly plans: VerificationProviderPlanInput[];
  readonly starts: VerificationProviderStartInput[];
  readonly completions: unknown[];
}

function recordedTransport(mode: FakeProviderMode): RecordedFakeTransport {
  const inner = makeFakeVerificationTransport({ mode });
  const plans: VerificationProviderPlanInput[] = [];
  const starts: VerificationProviderStartInput[] = [];
  const completions: unknown[] = [];
  return {
    plans,
    starts,
    completions,
    plan: (input) => {
      plans.push(input);
      return inner.plan(input);
    },
    start: (input) => {
      starts.push(input);
      return inner.start(input);
    },
    complete: (input) => {
      completions.push(input.submission);
      return inner.complete(input);
    },
  };
}

describe("verification provider adapter boundary", () => {
  test("fake provider registers and passes the reusable conformance fixture", async () => {
    const result = await runProviderConformance({
      adapter: makeFakeVerificationProvider(),
      startInput: FAKE_START_INPUT,
      submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
    });
    expect(result.provider.manifest).toEqual(FAKE_PROVIDER_MANIFEST);
    expect(result.sessionId).toBe("fake-session-1");
    expect(result.evidenceBundleId).toBe("fake-bundle-1");
  });

  test("drives provider-transport scenarios through the shared harness", async () => {
    const submission = {
      kind: "fake-submission",
      request_hash: FAKE_START_INPUT.request_hash,
    };
    await runProviderTransportConformance([
      {
        name: "valid transport",
        makeTransport: () => recordedTransport("valid"),
        makeAdapter: (transport) => makeFakeVerificationProvider({ transport }),
        startInput: FAKE_START_INPUT,
        submission,
        operation: "complete",
        expected: "success",
        assertTransport: (transport) => {
          expect(transport.plans).toHaveLength(1);
          expect(transport.starts).toEqual([FAKE_START_INPUT]);
          expect(transport.completions).toEqual([submission]);
        },
      },
      {
        name: "unavailable transport",
        makeTransport: () => recordedTransport("unavailable"),
        makeAdapter: (transport) => makeFakeVerificationProvider({ transport }),
        startInput: FAKE_START_INPUT,
        submission,
        operation: "start",
        expected: "VerificationProviderUnavailable",
        assertTransport: (transport) => {
          expect(transport.plans).toHaveLength(1);
          expect(transport.starts).toEqual([FAKE_START_INPUT]);
          expect(transport.completions).toEqual([]);
        },
      },
      {
        name: "malformed translated evidence",
        makeTransport: () => recordedTransport("duplicate-assertion-id"),
        makeAdapter: (transport) => makeFakeVerificationProvider({ transport }),
        startInput: FAKE_START_INPUT,
        submission,
        operation: "complete",
        expected: "VerificationProviderInvalidResponse",
        assertTransport: (transport) => {
          expect(transport.plans).toHaveLength(1);
          expect(transport.starts).toEqual([FAKE_START_INPUT]);
          expect(transport.completions).toEqual([submission]);
        },
      },
      {
        name: "tampered session after successful start",
        makeTransport: () => recordedTransport("valid"),
        makeAdapter: (transport) => makeFakeVerificationProvider({ transport }),
        startInput: FAKE_START_INPUT,
        submission,
        operation: "complete",
        tamperSession: (session) => ({ ...session, request_hash: "2".repeat(64) }),
        expected: "VerificationProviderRejected",
        assertTransport: (transport) => {
          expect(transport.plans).toHaveLength(1);
          expect(transport.starts).toEqual([FAKE_START_INPUT]);
          expect(transport.completions).toEqual([submission]);
        },
      },
    ]);
  });

  test("rejects manifests with duplicate or unknown metadata", async () => {
    const duplicateProtocols = await Effect.runPromiseExit(
      validateProofProviderManifest({
        ...FAKE_PROVIDER_MANIFEST,
        protocol_versions: ["fake-v2", "fake-v2"],
      }),
    );
    expect(failureOf(duplicateProtocols)).toBeInstanceOf(VerificationProviderManifestInvalid);

    const unknownClaim = await Effect.runPromiseExit(
      validateProofProviderManifest({
        ...FAKE_PROVIDER_MANIFEST,
        claim_ids: ["not-a-canonical-claim"],
      }),
    );
    expect(failureOf(unknownClaim)).toBeInstanceOf(VerificationProviderManifestInvalid);

    const capabilityMismatch = await Effect.runPromiseExit(
      validateProofProviderManifest({
        ...FAKE_PROVIDER_MANIFEST,
        claim_capabilities: [{ claim_id: "document.valid", request_modes: ["dynamic", "dynamic"] }],
      }),
    );
    expect(failureOf(capabilityMismatch)).toMatchObject({
      _tag: "VerificationProviderManifestInvalid",
      field: "claim_capabilities",
    });

    const liveWithoutLiveness = await Effect.runPromiseExit(
      validateProofProviderManifest({
        ...FAKE_PROVIDER_MANIFEST,
        claim_ids: ["human.live"],
        claim_capabilities: [{ claim_id: "human.live", request_modes: ["dynamic"] }],
        assurance_levels: ["document_zk"],
      }),
    );
    expect(failureOf(liveWithoutLiveness)).toMatchObject({
      _tag: "VerificationProviderManifestInvalid",
      field: "assurance_levels",
    });
  });

  test("enforces requested claims before calling a provider", async () => {
    const registry = await registered();
    const provider = await Effect.runPromise(registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id));
    const rejected = await Effect.runPromiseExit(
      provider.start({
        ...FAKE_START_INPUT,
        requested_requirements: [
          {
            claim_id: "asset.ownership",
            descriptor: {
              kind: "collection",
              schema_version: "1",
              chain_id: "eip155:137",
              asset_id: "eip155:137/erc721:0x0000000000000000000000000000000000000001",
              contract_address: "0x0000000000000000000000000000000000000001",
              normalized_match: "test-collection",
              match_semantics: "exact",
            },
            minimum_quantity: "1",
          },
        ],
        requested_claim_ids: ["asset.ownership"],
      }),
    );
    expect(failureOf(rejected)).toBeInstanceOf(VerificationProviderRejected);
  });

  test("preserves canonical requirements and fences incompatible sessions", async () => {
    const registry = await registered();
    const provider = await Effect.runPromise(registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id));
    const started = await Effect.runPromise(provider.start(FAKE_START_INPUT));
    expect(started.session.upstream_session_ref).toBe("fake-upstream-session-1");
    expect(started.session.requested_claim_ids).toEqual([
      "credential.subject_unique",
      "document.valid",
    ]);
    expect(started.session.requested_requirements).toEqual(FAKE_START_INPUT.requested_requirements);

    const incompatible = await Effect.runPromiseExit(
      provider.complete({
        session: { ...started.session, protocol_version: "other-v2" },
        submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
      }),
    );
    expect(failureOf(incompatible)).toBeInstanceOf(VerificationProviderRejected);

    for (const session of [
      { ...started.session, status: "expired" as const },
      { ...started.session, status: "failed" as const },
      { ...started.session, expires_at: "2000-01-01T00:00:00.000Z" },
      { ...started.session, expires_at: "not-a-timestamp" },
    ]) {
      const inactive = await Effect.runPromiseExit(
        provider.complete({
          session,
          submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
        }),
      );
      expect(failureOf(inactive)).toBeInstanceOf(VerificationProviderRejected);
    }
  });

  test("rejects unrequested output and broken binding references", async () => {
    for (const mode of [
      "undeclared-output",
      "undeclared-assurance",
      "duplicate-assertion-id",
      "invalid-binding-reference",
      "mismatched-binding-anchor",
      "mismatched-receipt-subject",
    ] as const) {
      const registry = await registered(mode);
      const provider = await Effect.runPromise(
        registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id),
      );
      const started = await Effect.runPromise(provider.start(FAKE_START_INPUT));
      const invalid = await Effect.runPromiseExit(
        provider.complete({
          session: started.session,
          submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
        }),
      );
      expect(failureOf(invalid)).toBeInstanceOf(VerificationProviderInvalidResponse);
    }
  });

  test("does not accept document assurance as holder liveness", async () => {
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([
        makeFakeVerificationProvider({
          manifest: {
            ...FAKE_PROVIDER_MANIFEST,
            claim_ids: ["human.live"],
            claim_capabilities: [{ claim_id: "human.live", request_modes: ["dynamic"] }],
            assurance_levels: ["holder_live", "document_zk"],
          },
        }),
      ]),
    );
    const provider = await Effect.runPromise(registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id));
    const humanLiveInput: VerificationProviderStartInput = {
      ...FAKE_START_INPUT,
      request_hash: "5c2d14a3004136348139e14b8dc89e83a1cf9221c70ea8e0b403a99717de77de",
      requested_requirements: [{ claim_id: "human.live" }],
      requested_claim_ids: ["human.live"],
    };
    const started = await Effect.runPromise(provider.start(humanLiveInput));
    const invalid = await Effect.runPromiseExit(
      provider.complete({
        session: started.session,
        submission: { kind: "fake-submission", request_hash: humanLiveInput.request_hash },
      }),
    );
    expect(failureOf(invalid)).toBeInstanceOf(VerificationProviderInvalidResponse);
  });

  test("rejects evidence whose scope, protocol, or environment changes", async () => {
    for (const mode of [
      "scope-mismatch",
      "subject-scope-mismatch",
      "subject-method-mismatch",
      "protocol-mismatch",
      "environment-mismatch",
    ] as const) {
      const registry = await registered(mode);
      const provider = await Effect.runPromise(
        registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id),
      );
      const started = await Effect.runPromise(provider.start(FAKE_START_INPUT));
      const invalid = await Effect.runPromiseExit(
        provider.complete({
          session: started.session,
          submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
        }),
      );
      expect(failureOf(invalid)).toBeInstanceOf(VerificationProviderInvalidResponse);
    }
  });

  test("preserves typed unavailable failures without exposing provider payloads", async () => {
    const unavailableRegistry = await registered("unavailable");
    const unavailableProvider = await Effect.runPromise(
      unavailableRegistry.resolve(FAKE_PROVIDER_MANIFEST.provider_id),
    );
    const startFailure = await Effect.runPromiseExit(unavailableProvider.start(FAKE_START_INPUT));
    expect(failureOf(startFailure)).toBeInstanceOf(VerificationProviderUnavailable);

    const validRegistry = await registered();
    const validProvider = await Effect.runPromise(
      validRegistry.resolve(FAKE_PROVIDER_MANIFEST.provider_id),
    );
    const started = await Effect.runPromise(validProvider.start(FAKE_START_INPUT));
    const completeFailure = await Effect.runPromiseExit(
      unavailableProvider.complete({
        session: started.session,
        submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
      }),
    );
    expect(failureOf(completeFailure)).toBeInstanceOf(VerificationProviderUnavailable);
  });

  test("binds fake submissions to the session request hash", async () => {
    const registry = await registered();
    const provider = await Effect.runPromise(registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id));
    const started = await Effect.runPromise(provider.start(FAKE_START_INPUT));
    for (const submission of [
      { kind: "fake-submission" },
      {
        kind: "fake-submission",
        request_hash: "2222222222222222222222222222222222222222222222222222222222222222",
      },
    ]) {
      const rejected = await Effect.runPromiseExit(
        provider.complete({ session: started.session, submission }),
      );
      expect(failureOf(rejected)).toBeInstanceOf(VerificationProviderRejected);
    }
  });

  test("supports a native no-subject provider with receipt-bound assertions", async () => {
    const registry = await Effect.runPromise(
      makeVerificationProviderRegistry([makeFakeVerificationProvider({ mode: "no-subject" })]),
    );
    const provider = await Effect.runPromise(
      registry.resolve(NO_SUBJECT_FAKE_PROVIDER_MANIFEST.provider_id),
    );
    const noSubjectInput: VerificationProviderStartInput = {
      ...FAKE_START_INPUT,
      request_hash: "34bf7581f529b1c1261bcb93da90fea75e8eb8827f87fb838b0b52306d1f5937",
      scope: { kind: "none", issuer: NO_SUBJECT_FAKE_PROVIDER_MANIFEST.provider_id },
      requested_requirements: [{ claim_id: "document.valid" }],
      requested_claim_ids: ["document.valid"],
      subject_binding_intent: "none",
    };
    const started = await Effect.runPromise(provider.start(noSubjectInput));
    const bundle = await Effect.runPromise(
      provider.complete({
        session: started.session,
        submission: { kind: "fake-submission", request_hash: noSubjectInput.request_hash },
      }),
    );
    expect(bundle.subject_keys).toEqual([]);
    expect(bundle.receipts[0]?.subject_key_id).toBeUndefined();
    expect(bundle.assertions[0]?.subject_key_id).toBeUndefined();
    expect(bundle.binding_groups[0]?.kind).toBe("same_receipt");

    for (const subject_binding_intent of ["establish", "recover"] as const) {
      const rejected = await Effect.runPromiseExit(
        provider.start({
          ...FAKE_START_INPUT,
          scope: { kind: "none", issuer: NO_SUBJECT_FAKE_PROVIDER_MANIFEST.provider_id },
          requested_requirements: [{ claim_id: "document.valid" }],
          requested_claim_ids: ["document.valid"],
          subject_binding_intent,
        }),
      );
      expect(failureOf(rejected)).toBeInstanceOf(VerificationProviderRejected);
    }
  });

  test("preserves typed misconfiguration failures", async () => {
    const registry = await registered("misconfigured");
    const provider = await Effect.runPromise(registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id));
    const startFailure = await Effect.runPromiseExit(provider.start(FAKE_START_INPUT));
    expect(failureOf(startFailure)).toBeInstanceOf(VerificationProviderMisconfigured);
  });

  test("redacts synchronous throws and Effect defects as typed invalid responses", async () => {
    const throwingRegistry = await registered("throw-start");
    const throwingProvider = await Effect.runPromise(
      throwingRegistry.resolve(FAKE_PROVIDER_MANIFEST.provider_id),
    );
    const thrown = await Effect.runPromiseExit(throwingProvider.start(FAKE_START_INPUT));
    expect(failureOf(thrown)).toBeInstanceOf(VerificationProviderInvalidResponse);

    const defectRegistry = await registered("defect-complete");
    const defectProvider = await Effect.runPromise(
      defectRegistry.resolve(FAKE_PROVIDER_MANIFEST.provider_id),
    );
    const started = await Effect.runPromise(defectProvider.start(FAKE_START_INPUT));
    const defect = await Effect.runPromiseExit(
      defectProvider.complete({
        session: started.session,
        submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
      }),
    );
    expect(failureOf(defect)).toBeInstanceOf(VerificationProviderInvalidResponse);
  });

  test("rejects duplicate IDs and unknown IDs through the registry", async () => {
    const adapter = makeFakeVerificationProvider();
    const duplicate = await Effect.runPromiseExit(
      makeVerificationProviderRegistry([adapter, adapter]),
    );
    expect(failureOf(duplicate)).toMatchObject({
      _tag: "VerificationProviderDuplicate",
      provider_id: FAKE_PROVIDER_MANIFEST.provider_id,
    });

    const registry = await Effect.runPromise(makeVerificationProviderRegistry([adapter]));
    const unknown = await Effect.runPromiseExit(registry.resolve("missing.provider"));
    expect(failureOf(unknown)).toMatchObject({
      _tag: "VerificationProviderUnknown",
      provider_id: "missing.provider",
    });
  });
});
