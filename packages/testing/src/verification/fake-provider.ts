import {
  type ProviderSessionStart,
  type VerificationProviderAdapter,
  VerificationProviderMisconfigured,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
  VerificationProviderUnavailable,
  type VerificationProviderVerifyInput,
} from "@pirate/application/verification";
import type {
  CanonicalClaimIdentifier,
  EvidenceBundle,
  NamedIssuerScope,
  ProofProviderManifest,
  ProofSession,
  SubjectScope,
} from "@pirate/domain/verification";
import { Effect, Schema } from "effect";

export const FAKE_PROVIDER_MANIFEST: ProofProviderManifest = {
  provider_id: "test.fake",
  manifest_version: "1",
  protocol_versions: ["fake-v2"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["document.valid", "credential.subject_unique", "age.minimum"],
  presentation_kinds: ["none"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

export const NO_SUBJECT_FAKE_PROVIDER_MANIFEST: ProofProviderManifest = {
  provider_id: "test.fake.no-subject",
  manifest_version: "1",
  protocol_versions: ["fake-v2"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["document.valid"],
  presentation_kinds: ["none"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "none",
};

export type FakeProviderMode =
  | "valid"
  | "unavailable"
  | "misconfigured"
  | "throw-start"
  | "defect-verify"
  | "no-subject"
  | "undeclared-output"
  | "undeclared-assurance"
  | "duplicate-assertion-id"
  | "invalid-binding-reference"
  | "mismatched-binding-anchor"
  | "mismatched-receipt-subject"
  | "subject-scope-mismatch"
  | "subject-method-mismatch"
  | "scope-mismatch"
  | "protocol-mismatch"
  | "environment-mismatch";

export type FakeProviderOptions = Readonly<{
  readonly mode?: FakeProviderMode;
  readonly manifest?: ProofProviderManifest;
}>;

const FakeSubmission = Schema.Struct({
  kind: Schema.Literal("fake-submission"),
  request_hash: Schema.NonEmptyString,
});

function validateSubmission(input: VerificationProviderVerifyInput, provider_id: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(FakeSubmission)(input.submission),
    catch: () => new VerificationProviderRejected({ provider_id, operation: "verify" }),
  }).pipe(
    Effect.flatMap((submission) =>
      submission.request_hash === input.session.request_hash
        ? Effect.succeed(submission)
        : Effect.fail(new VerificationProviderRejected({ provider_id, operation: "verify" })),
    ),
  );
}

function startResult(
  input: VerificationProviderStartInput,
  provider_id: string,
): ProviderSessionStart {
  const session: ProofSession = {
    id: "fake-session-1",
    actor_id: input.actor_id,
    intent_id: input.intent_id,
    request_hash: input.request_hash,
    provider_id,
    method: input.method,
    scope: input.scope,
    requested_claim_ids: input.requested_claim_ids,
    protocol_version: input.protocol_version,
    environment: input.environment,
    status: "pending",
    started_at: "2026-08-17T00:00:00.000Z",
    expires_at: "2099-08-17T01:00:00.000Z",
  };
  return {
    session,
    presentation: { kind: "none", session_id: session.id },
  };
}

function bundleFor(input: VerificationProviderVerifyInput, mode: FakeProviderMode): EvidenceBundle {
  const session = input.session;
  const noSubject = mode === "no-subject";
  const receiptId = "fake-receipt-1";
  const subjectKeyId = "fake-subject-1";
  const bindingGroupId = "fake-binding-1";
  const subjectScope: NamedIssuerScope =
    mode === "subject-scope-mismatch"
      ? {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: session.scope.issuer,
          rp_scope: "other-rp",
        }
      : {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: session.scope.issuer,
          rp_scope: session.scope.kind === "named" ? session.scope.rp_scope : "test-rp",
        };
  const subjectMethod = mode === "subject-method-mismatch" ? "other-method" : session.method;
  const receiptScope: SubjectScope =
    mode === "scope-mismatch"
      ? {
          kind: "named",
          scope_semantics: "issuer_rp_scope",
          issuer: "test.fake",
          rp_scope: "other-rp",
        }
      : session.scope;
  const protocolVersion = mode === "protocol-mismatch" ? "other-v2" : session.protocol_version;
  const environment = mode === "environment-mismatch" ? "production" : session.environment;
  const requested = [...session.requested_claim_ids];
  const claims: readonly CanonicalClaimIdentifier[] =
    mode === "undeclared-output" ? [...requested, "age.minimum"] : requested;
  const assertions: EvidenceBundle["assertions"] = claims.map((claim, index) => ({
    id: mode === "duplicate-assertion-id" ? "fake-assertion-1" : `fake-assertion-${index + 1}`,
    ...(noSubject ? {} : { subject_key_id: subjectKeyId }),
    evidence_receipt_id: receiptId,
    claim_id: claim,
    assurance: mode === "undeclared-assurance" ? "holder_live" : "document_zk",
    binding_group_id: bindingGroupId,
    value:
      claim === "age.minimum"
        ? { minimum_age: 18 }
        : claim === "document.valid"
          ? { valid: true }
          : { subject_unique: true },
    observed_at: "2026-08-17T00:00:00.000Z",
  }));
  const bundle: EvidenceBundle = {
    id: "fake-bundle-1",
    proof_session_id: session.id,
    receipts: [
      {
        id: receiptId,
        proof_session_id: session.id,
        provider_id: session.provider_id,
        issuer: session.scope.issuer,
        method: session.method,
        scope: receiptScope,
        protocol_version: protocolVersion,
        environment,
        provenance_kind: "proof_session",
        evidence_hash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        observed_at: "2026-08-17T00:00:00.000Z",
        ...(noSubject
          ? {}
          : {
              subject_key_id:
                mode === "mismatched-receipt-subject" ? "fake-subject-2" : subjectKeyId,
            }),
      },
    ],
    subject_keys: noSubject
      ? []
      : [
          {
            id: subjectKeyId,
            issuer: session.scope.issuer,
            method: subjectMethod,
            scope: {
              ...subjectScope,
            },
            subject_digest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
          },
          ...(mode === "mismatched-binding-anchor" || mode === "mismatched-receipt-subject"
            ? [
                {
                  id: "fake-subject-2",
                  issuer: session.scope.issuer,
                  method: session.method,
                  scope: {
                    ...subjectScope,
                  },
                  subject_digest:
                    "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
                },
              ]
            : []),
        ],
    binding_groups: noSubject
      ? [{ id: bindingGroupId, kind: "same_receipt", evidence_receipt_id: receiptId }]
      : [
          {
            id: bindingGroupId,
            kind: "same_subject",
            subject_key_id:
              mode === "invalid-binding-reference"
                ? "missing-subject"
                : mode === "mismatched-binding-anchor"
                  ? "fake-subject-2"
                  : subjectKeyId,
          },
        ],
    assertions,
  };
  return bundle;
}

/**
 * A deterministic provider fixture. It imports only the stable application
 * adapter boundary and domain verification values, so it is also the
 * registration proof used by the dependency-boundary tests.
 */
export function makeFakeVerificationProvider(
  options: FakeProviderOptions = {},
): VerificationProviderAdapter {
  const mode = options.mode ?? "valid";
  const manifest =
    options.manifest ??
    (mode === "no-subject" ? NO_SUBJECT_FAKE_PROVIDER_MANIFEST : FAKE_PROVIDER_MANIFEST);
  return {
    manifest,
    start: (input) => {
      if (mode === "throw-start") {
        throw new Error("fake provider start secret");
      }
      if (mode === "unavailable") {
        return Effect.fail(
          new VerificationProviderUnavailable({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
        );
      }
      if (mode === "misconfigured") {
        return Effect.fail(
          new VerificationProviderMisconfigured({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
        );
      }
      if (!manifest.supported_methods.includes(input.method)) {
        return Effect.fail(
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
        );
      }
      return Effect.succeed(startResult(input, manifest.provider_id));
    },
    verify: (input) => {
      if (mode === "defect-verify") {
        return Effect.die(new Error("fake provider verify secret"));
      }
      if (mode === "unavailable") {
        return Effect.fail(
          new VerificationProviderUnavailable({
            provider_id: manifest.provider_id,
            operation: "verify",
          }),
        );
      }
      if (mode === "misconfigured") {
        return Effect.fail(
          new VerificationProviderMisconfigured({
            provider_id: manifest.provider_id,
            operation: "verify",
          }),
        );
      }
      return validateSubmission(input, manifest.provider_id).pipe(
        Effect.map(() => bundleFor(input, mode)),
      );
    },
  };
}
