import { describe, expect, test } from "bun:test";
import {
  makeVerificationProviderRegistry,
  VerificationProviderInvalidResponse,
  VerificationProviderManifestInvalid,
  VerificationProviderMisconfigured,
  VerificationProviderRejected,
  VerificationProviderUnavailable,
  validateProofProviderManifest,
} from "@pirate/application/verification";
import { Cause, Effect, Exit, Result } from "effect";
import type { FakeProviderMode } from "./fake-provider.ts";
import {
  FAKE_PROVIDER_MANIFEST,
  makeFakeVerificationProvider,
  NO_SUBJECT_FAKE_PROVIDER_MANIFEST,
} from "./fake-provider.ts";
import { FAKE_START_INPUT, runProviderConformance } from "./provider-conformance.ts";

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

describe("verification provider adapter boundary", () => {
  test("fake provider registers and passes the reusable conformance fixture", async () => {
    const result = await runProviderConformance(makeFakeVerificationProvider());
    expect(result.provider.manifest).toEqual(FAKE_PROVIDER_MANIFEST);
    expect(result.sessionId).toBe("fake-session-1");
    expect(result.evidenceBundleId).toBe("fake-bundle-1");
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

    const liveWithoutLiveness = await Effect.runPromiseExit(
      validateProofProviderManifest({
        ...FAKE_PROVIDER_MANIFEST,
        claim_ids: ["human.live"],
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
        requested_claim_ids: ["asset.ownership"],
      }),
    );
    expect(failureOf(rejected)).toBeInstanceOf(VerificationProviderRejected);
  });

  test("treats requested claims as a duplicate-free set and fences incompatible sessions", async () => {
    const registry = await registered();
    const provider = await Effect.runPromise(registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id));
    const reordered = await Effect.runPromise(
      provider.start({
        ...FAKE_START_INPUT,
        requested_claim_ids: ["credential.subject_unique", "document.valid"],
      }),
    );
    expect(reordered.session.requested_claim_ids).toEqual([
      "credential.subject_unique",
      "document.valid",
    ]);

    const incompatible = await Effect.runPromiseExit(
      provider.verify({
        session: { ...reordered.session, protocol_version: "other-v2" },
        submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
      }),
    );
    expect(failureOf(incompatible)).toBeInstanceOf(VerificationProviderRejected);

    for (const session of [
      { ...reordered.session, status: "expired" as const },
      { ...reordered.session, status: "failed" as const },
      { ...reordered.session, expires_at: "2000-01-01T00:00:00.000Z" },
      { ...reordered.session, expires_at: "not-a-timestamp" },
    ]) {
      const inactive = await Effect.runPromiseExit(
        provider.verify({
          session,
          submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
        }),
      );
      expect(failureOf(inactive)).toBeInstanceOf(VerificationProviderRejected);
    }
  });

  test("rejects undeclared claims and broken binding references", async () => {
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
        provider.verify({
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
            assurance_levels: ["holder_live", "document_zk"],
          },
        }),
      ]),
    );
    const provider = await Effect.runPromise(registry.resolve(FAKE_PROVIDER_MANIFEST.provider_id));
    const started = await Effect.runPromise(
      provider.start({ ...FAKE_START_INPUT, requested_claim_ids: ["human.live"] }),
    );
    const invalid = await Effect.runPromiseExit(
      provider.verify({
        session: started.session,
        submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
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
        provider.verify({
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
    const verifyFailure = await Effect.runPromiseExit(
      unavailableProvider.verify({
        session: started.session,
        submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
      }),
    );
    expect(failureOf(verifyFailure)).toBeInstanceOf(VerificationProviderUnavailable);
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
        provider.verify({ session: started.session, submission }),
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
    const started = await Effect.runPromise(
      provider.start({
        ...FAKE_START_INPUT,
        scope: { kind: "none", issuer: NO_SUBJECT_FAKE_PROVIDER_MANIFEST.provider_id },
        requested_claim_ids: ["document.valid"],
      }),
    );
    const bundle = await Effect.runPromise(
      provider.verify({
        session: started.session,
        submission: { kind: "fake-submission", request_hash: FAKE_START_INPUT.request_hash },
      }),
    );
    expect(bundle.subject_keys).toEqual([]);
    expect(bundle.receipts[0]?.subject_key_id).toBeUndefined();
    expect(bundle.assertions[0]?.subject_key_id).toBeUndefined();
    expect(bundle.binding_groups[0]?.kind).toBe("same_receipt");
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

    const defectRegistry = await registered("defect-verify");
    const defectProvider = await Effect.runPromise(
      defectRegistry.resolve(FAKE_PROVIDER_MANIFEST.provider_id),
    );
    const started = await Effect.runPromise(defectProvider.start(FAKE_START_INPUT));
    const defect = await Effect.runPromiseExit(
      defectProvider.verify({
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
