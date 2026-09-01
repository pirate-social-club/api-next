import {
  makeVerificationProviderRegistry,
  type ProviderSessionStart,
  type VerificationProviderAdapter,
  type VerificationProviderCompleteInput,
  VerificationProviderMisconfigured,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
  VerificationProviderUnavailable,
} from "@pirate/application/verification";
import type {
  Assertion,
  Assurance,
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
  operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 5000, callback_ms: 5000 },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: ["fake-v2"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["document.valid", "credential.subject_unique", "age.minimum"],
  claim_capabilities: [
    { claim_id: "document.valid", request_modes: ["dynamic"] },
    { claim_id: "credential.subject_unique", request_modes: ["dynamic"] },
    { claim_id: "age.minimum", request_modes: ["dynamic"] },
  ],
  presentation_kinds: ["none"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

export const NO_SUBJECT_FAKE_PROVIDER_MANIFEST: ProofProviderManifest = {
  provider_id: "test.fake.no-subject",
  manifest_version: "1",
  operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 5000, callback_ms: 5000 },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: ["fake-v2"],
  environments: ["test"],
  supported_methods: ["document"],
  claim_ids: ["document.valid"],
  claim_capabilities: [{ claim_id: "document.valid", request_modes: ["dynamic"] }],
  presentation_kinds: ["none"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "none",
};

export type FakeProviderMode =
  | "valid"
  | "unavailable"
  | "misconfigured"
  | "throw-start"
  | "defect-complete"
  | "no-subject"
  | "unrequested-output"
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
  readonly transport?: FakeProviderTransport;
  readonly verifyCallback?: NonNullable<VerificationProviderAdapter["verifyCallback"]>;
}>;

export interface FakeProviderTransport {
  readonly plan: VerificationProviderAdapter["plan"];
  readonly start: VerificationProviderAdapter["start"];
  readonly complete: VerificationProviderAdapter["complete"];
}

const FakeSubmission = Schema.Struct({
  kind: Schema.Literal("fake-submission"),
  request_hash: Schema.NonEmptyString,
});

function validateSubmission(input: VerificationProviderCompleteInput, provider_id: string) {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(FakeSubmission)(input.submission.payload),
    catch: () => new VerificationProviderRejected({ provider_id, operation: "complete" }),
  }).pipe(
    Effect.flatMap((submission) =>
      submission.request_hash === input.session.request_hash
        ? Effect.succeed(submission)
        : Effect.fail(new VerificationProviderRejected({ provider_id, operation: "complete" })),
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
    upstream_session_ref: "fake-upstream-session-1",
    method: input.method,
    scope: input.scope,
    request_mode: input.request_mode,
    provider_configuration: input.provider_configuration,
    requested_requirements: input.requested_requirements,
    requested_claim_ids: input.requested_claim_ids,
    subject_binding_intent: input.subject_binding_intent,
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

function assertionFor(input: {
  readonly claim: CanonicalClaimIdentifier;
  readonly index: number;
  readonly mode: FakeProviderMode;
  readonly noSubject: boolean;
  readonly subjectKeyId: string;
  readonly receiptId: string;
  readonly bindingGroupId: string;
}): Assertion {
  const assurance: Assurance =
    input.mode === "undeclared-assurance" ? "holder_live" : "document_zk";
  const common = {
    id:
      input.mode === "duplicate-assertion-id"
        ? "fake-assertion-1"
        : `fake-assertion-${input.index + 1}`,
    ...(input.noSubject ? {} : { subject_key_id: input.subjectKeyId }),
    evidence_receipt_id: input.receiptId,
    assurance,
    binding_group_id: input.bindingGroupId,
    observed_at: "2026-08-17T00:00:00.000Z",
  } as const;
  switch (input.claim) {
    case "human.live":
      return { ...common, claim_id: input.claim, value: { live: true } };
    case "human.personhood":
      return { ...common, claim_id: input.claim, value: { personhood: true } };
    case "human.unique":
      return { ...common, claim_id: input.claim, value: { unique: true } };
    case "credential.subject_unique":
      return { ...common, claim_id: input.claim, value: { subject_unique: true } };
    case "document.valid":
      return { ...common, claim_id: input.claim, value: { valid: true } };
    case "document.holder_bound":
      return { ...common, claim_id: input.claim, value: { holder_bound: true } };
    case "age.minimum":
      return { ...common, claim_id: input.claim, value: { minimum_age: "18" } };
    case "nationality.allowed":
      return { ...common, claim_id: input.claim, value: { allowed: true } };
    case "gender.marker":
      return { ...common, claim_id: input.claim, value: { gender: "unspecified" } };
    case "asset.ownership":
      return {
        ...common,
        claim_id: input.claim,
        value: {
          owned: true,
          quantity: "1",
          descriptor: {
            kind: "collection",
            schema_version: "1",
            chain_id: "eip155:137",
            asset_id: "eip155:137/erc721:0x0000000000000000000000000000000000000001",
            contract_address: "0x0000000000000000000000000000000000000001",
            normalized_match: "test-collection",
            match_semantics: "exact",
          },
        },
      };
    case "disclosed.predicate":
      return {
        ...common,
        claim_id: input.claim,
        value: { predicate: "test.predicate", value: true },
      };
  }
}

function bundleFor(
  input: VerificationProviderCompleteInput,
  mode: FakeProviderMode,
): EvidenceBundle {
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
    mode === "unrequested-output" ? [...requested, "age.minimum"] : requested;
  const assertions: EvidenceBundle["assertions"] = claims.map((claim, index) =>
    assertionFor({
      claim,
      index,
      mode,
      noSubject,
      subjectKeyId,
      receiptId,
      bindingGroupId,
    }),
  );
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
        provider_configuration: session.provider_configuration,
        protocol_version: protocolVersion,
        environment,
        provenance_kind: "proof_session",
        evidence_kind: session.method,
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
  const baseManifest =
    options.manifest ??
    (mode === "no-subject" ? NO_SUBJECT_FAKE_PROVIDER_MANIFEST : FAKE_PROVIDER_MANIFEST);
  const manifest =
    options.verifyCallback === undefined
      ? baseManifest
      : {
          ...baseManifest,
          callback_mode: "signed_envelope" as const,
          callback_header_allowlist: ["webhook-signature"],
        };
  const transport = options.transport ?? makeFakeVerificationTransport({ manifest, mode });
  return {
    manifest,
    plan: (input) => transport.plan(input),
    start: (input) => transport.start(input),
    complete: (input) => transport.complete(input),
    ...(options.verifyCallback === undefined ? {} : { verifyCallback: options.verifyCallback }),
  };
}

export function makeFakeVerificationProviderRegistry(options: FakeProviderOptions = {}) {
  return makeVerificationProviderRegistry([makeFakeVerificationProvider(options)], {
    now: () => Date.parse("2026-08-17T00:00:00.000Z"),
  });
}

export function makeFakeVerificationTransport(
  options: Pick<FakeProviderOptions, "manifest" | "mode"> = {},
): FakeProviderTransport {
  const mode = options.mode ?? "valid";
  const manifest =
    options.manifest ??
    (mode === "no-subject" ? NO_SUBJECT_FAKE_PROVIDER_MANIFEST : FAKE_PROVIDER_MANIFEST);
  return {
    plan: () =>
      Effect.succeed({
        status: "supported" as const,
        request_mode: "dynamic" as const,
        provider_configuration: {
          kind: "dynamic" as const,
          reference: "fake-query",
          version: "1",
        },
      }),
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
    complete: (input) => {
      if (mode === "defect-complete") {
        return Effect.die(new Error("fake provider verify secret"));
      }
      if (mode === "unavailable") {
        return Effect.fail(
          new VerificationProviderUnavailable({
            provider_id: manifest.provider_id,
            operation: "complete",
          }),
        );
      }
      if (mode === "misconfigured") {
        return Effect.fail(
          new VerificationProviderMisconfigured({
            provider_id: manifest.provider_id,
            operation: "complete",
          }),
        );
      }
      return validateSubmission(input, manifest.provider_id).pipe(
        Effect.map(() => bundleFor(input, mode)),
      );
    },
  };
}
