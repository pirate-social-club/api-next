import {
  type ProviderSessionStart,
  type VerificationProviderAdapter,
  type VerificationProviderCompleteInput,
  type VerificationProviderFailure,
  VerificationProviderInvalidResponse,
  type VerificationProviderPlanInput,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
} from "@pirate/application/verification";
import {
  type Assertion,
  type CanonicalClaimIdentifier,
  type CanonicalIsoInstant,
  type EvidenceBundle,
  Iso3166Alpha2,
  NonNegativeIntegerString,
  type ProofProviderManifest,
  type ProofSession,
  type ProviderConfigurationRef,
  Sha256Hex,
  type SubjectScope,
  sameVerificationRequirements,
  type VerificationRequirement,
  type VerificationRequirements,
} from "@pirate/domain/verification";
import { Effect, Option, Schema } from "effect";

const SELF_ENTERPRISE_PROVIDER_ID = "self.enterprise" as const;
export const SELF_ENTERPRISE_PROTOCOL_VERSION = "self-enterprise-v1" as const;

const SELF_ENTERPRISE_CLAIMS = [
  "age.minimum",
  "credential.subject_unique",
  "document.holder_bound",
  "document.valid",
  "gender.marker",
  "nationality.allowed",
] as const satisfies readonly CanonicalClaimIdentifier[];

export const SELF_ENTERPRISE_MANIFEST: Schema.Schema.Type<typeof ProofProviderManifest> = {
  provider_id: SELF_ENTERPRISE_PROVIDER_ID,
  manifest_version: "1",
  operation_deadlines: { plan_ms: 1000, start_ms: 5000, complete_ms: 5000, callback_ms: 5000 },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: [SELF_ENTERPRISE_PROTOCOL_VERSION],
  environments: ["test", "development", "staging", "production"],
  supported_methods: ["document"],
  claim_ids: [...SELF_ENTERPRISE_CLAIMS],
  claim_capabilities: SELF_ENTERPRISE_CLAIMS.map((claim_id) => ({
    claim_id,
    request_modes: ["curated" as const],
  })),
  presentation_kinds: ["embedded_sdk"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

export type SelfEnterpriseFlow = Readonly<{
  readonly configuration: ProviderConfigurationRef & { readonly kind: "managed" };
  readonly method: string;
  readonly scope: SubjectScope;
  readonly requested_requirements: VerificationRequirements;
  readonly subject_binding_intent: "establish" | "recover";
  readonly protocol_version: string;
  readonly environment: string;
  readonly presentation_protocol: string;
  readonly presentation_version: string;
}>;

type SelfEnterpriseClock = Readonly<{
  readonly now: () => CanonicalIsoInstant;
  readonly expiresAt: (now: CanonicalIsoInstant) => CanonicalIsoInstant;
}>;

type SelfEnterpriseIdentifierKind =
  | "session"
  | "bundle"
  | "receipt"
  | "subject"
  | "binding"
  | "assertion";

type SelfEnterpriseIdentifiers = Readonly<{
  readonly next: (kind: SelfEnterpriseIdentifierKind) => string;
}>;

type SelfEnterpriseDigest = Readonly<{
  readonly digest: (value: string) => Effect.Effect<string, VerificationProviderFailure>;
}>;

type SelfEnterpriseStart = Readonly<{
  readonly upstream_session_ref: string;
  readonly presentation_payload: Schema.Schema.Type<typeof Schema.Json>;
}>;

const SelfEnterpriseStart = Schema.Struct({
  upstream_session_ref: Schema.NonEmptyString,
  presentation_payload: Schema.Json,
});

const SelfEnterpriseSubmission = Schema.Struct({
  kind: Schema.Literal("self-proof"),
  session_id: Schema.NonEmptyString,
  user_context_data: Schema.NonEmptyString,
  proof: Schema.Json,
  public_signals: Schema.NonEmptyArray(Schema.Json),
});
type SelfEnterpriseSubmission = Schema.Schema.Type<typeof SelfEnterpriseSubmission>;

const SelfEnterpriseVerifiedOutput = Schema.Struct({
  session_id: Schema.NonEmptyString,
  subject: Schema.NonEmptyString,
  subject_unique: Schema.Literal(true),
  document_valid: Schema.Literal(true),
  holder_bound: Schema.Literal(true),
  minimum_age: Schema.optional(NonNegativeIntegerString),
  nationality: Schema.optional(Iso3166Alpha2),
  nationality_allowed: Schema.optional(Schema.Literal(true)),
  gender: Schema.optional(Schema.Literals(["female", "male", "unspecified"])),
});
type SelfEnterpriseVerifiedOutput = Schema.Schema.Type<typeof SelfEnterpriseVerifiedOutput>;

export type SelfEnterpriseTransport = Readonly<{
  readonly start: (
    input: Readonly<{
      readonly request: VerificationProviderStartInput;
      readonly flow: SelfEnterpriseFlow;
    }>,
  ) => Effect.Effect<SelfEnterpriseStart, VerificationProviderFailure>;
  readonly verify: (
    input: Readonly<{
      readonly session: ProofSession;
      readonly flow: SelfEnterpriseFlow;
      readonly submission: SelfEnterpriseSubmission;
    }>,
  ) => Effect.Effect<unknown, VerificationProviderFailure>;
}>;

export type SelfEnterpriseAdapterOptions = Readonly<{
  /** `undefined` models an unavailable provider-flow catalog. */
  readonly flows: readonly SelfEnterpriseFlow[] | undefined;
  readonly transport: SelfEnterpriseTransport;
  readonly clock: SelfEnterpriseClock;
  readonly identifiers: SelfEnterpriseIdentifiers;
  readonly digest: SelfEnterpriseDigest;
}>;

function invalid(operation: "plan" | "start" | "complete"): VerificationProviderInvalidResponse {
  return new VerificationProviderInvalidResponse({
    provider_id: SELF_ENTERPRISE_PROVIDER_ID,
    operation,
  });
}

function rejected(operation: "start" | "complete"): VerificationProviderRejected {
  return new VerificationProviderRejected({
    provider_id: SELF_ENTERPRISE_PROVIDER_ID,
    operation,
  });
}

function sameConfiguration(
  left: ProviderConfigurationRef,
  right: ProviderConfigurationRef,
): boolean {
  return (
    left.kind === right.kind && left.reference === right.reference && left.version === right.version
  );
}

function sameScope(left: SubjectScope, right: SubjectScope): boolean {
  if (left.kind !== right.kind || left.issuer !== right.issuer) return false;
  if (left.kind === "none" && right.kind === "none") return true;
  if (left.kind !== "named" || right.kind !== "named") return false;
  if (left.scope_semantics !== right.scope_semantics || left.rp_scope !== right.rp_scope) {
    return false;
  }
  return left.scope_semantics === "issuer_rp_action_scope"
    ? right.scope_semantics === "issuer_rp_action_scope" && left.action_scope === right.action_scope
    : right.scope_semantics === "issuer_rp_scope";
}

function claimIds(
  requirements: readonly VerificationRequirement[],
): readonly CanonicalClaimIdentifier[] {
  return requirements.map((requirement) => requirement.claim_id);
}

function flowMatchesPlan(flow: SelfEnterpriseFlow, input: VerificationProviderPlanInput): boolean {
  return (
    flow.method === input.method &&
    sameScope(flow.scope, input.scope) &&
    sameVerificationRequirements(flow.requested_requirements, input.requested_requirements) &&
    JSON.stringify(claimIds(flow.requested_requirements)) ===
      JSON.stringify(input.requested_claim_ids) &&
    flow.subject_binding_intent === input.subject_binding_intent &&
    flow.protocol_version === input.protocol_version &&
    flow.environment === input.environment
  );
}

function flowMatchesSession(flow: SelfEnterpriseFlow, session: ProofSession): boolean {
  return (
    flow.configuration.kind === session.provider_configuration.kind &&
    flow.configuration.reference === session.provider_configuration.reference &&
    flow.configuration.version === session.provider_configuration.version &&
    flowMatchesPlan(flow, {
      method: session.method,
      scope: session.scope,
      requested_requirements: session.requested_requirements,
      requested_claim_ids: session.requested_claim_ids,
      subject_binding_intent: session.subject_binding_intent,
      protocol_version: session.protocol_version,
      environment: session.environment,
    })
  );
}

function findFlow(
  flows: readonly SelfEnterpriseFlow[] | undefined,
  input: VerificationProviderPlanInput,
): SelfEnterpriseFlow | undefined {
  return flows?.find((flow) => flowMatchesPlan(flow, input));
}

function decodeStart(
  value: unknown,
): Effect.Effect<SelfEnterpriseStart, VerificationProviderInvalidResponse> {
  const decoded = Schema.decodeUnknownOption(SelfEnterpriseStart)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("start"));
}

function decodeSubmission(
  value: unknown,
): Effect.Effect<SelfEnterpriseSubmission, VerificationProviderRejected> {
  const decoded = Schema.decodeUnknownOption(SelfEnterpriseSubmission)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(rejected("complete"));
}

function decodeVerified(
  value: unknown,
): Effect.Effect<SelfEnterpriseVerifiedOutput, VerificationProviderInvalidResponse> {
  const decoded = Schema.decodeUnknownOption(SelfEnterpriseVerifiedOutput)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("complete"));
}

function minimumAgeMeets(actual: string | undefined, required: string): boolean {
  if (actual === undefined) return false;
  try {
    return BigInt(actual) >= BigInt(required);
  } catch {
    return false;
  }
}

function assertionFor(
  claim_id: CanonicalClaimIdentifier,
  requirement: VerificationRequirement,
  output: SelfEnterpriseVerifiedOutput,
  ids: SelfEnterpriseIdentifiers,
  observed_at: CanonicalIsoInstant,
  subject_key_id: string,
  receipt_id: string,
  binding_group_id: string,
): Assertion | undefined {
  const common = {
    id: ids.next("assertion"),
    subject_key_id,
    evidence_receipt_id: receipt_id,
    assurance: "document_zk" as const,
    binding_group_id,
    observed_at,
  };
  switch (claim_id) {
    case "credential.subject_unique":
      return { ...common, claim_id, value: { subject_unique: true } };
    case "document.valid":
      return { ...common, claim_id, value: { valid: output.document_valid } };
    case "document.holder_bound":
      return { ...common, claim_id, value: { holder_bound: output.holder_bound } };
    case "age.minimum":
      return requirement.claim_id === "age.minimum" && output.minimum_age !== undefined
        ? { ...common, claim_id, value: { minimum_age: requirement.minimum_age } }
        : undefined;
    case "nationality.allowed":
      return requirement.claim_id === "nationality.allowed"
        ? {
            ...common,
            claim_id,
            value: {
              allowed: true,
              ...(output.nationality === undefined
                ? {}
                : { disclosed_nationality: output.nationality }),
            },
          }
        : undefined;
    case "gender.marker":
      return output.gender === undefined
        ? undefined
        : { ...common, claim_id, value: { gender: output.gender } };
    default:
      return undefined;
  }
}

function decodeDigest(
  value: string,
): Effect.Effect<Sha256Hex, VerificationProviderInvalidResponse> {
  const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("complete"));
}

function evidenceBundle(
  session: ProofSession,
  output: SelfEnterpriseVerifiedOutput,
  requirements: readonly VerificationRequirement[],
  runtime: Pick<SelfEnterpriseAdapterOptions, "clock" | "identifiers" | "digest">,
): Effect.Effect<EvidenceBundle, VerificationProviderFailure> {
  const observed_at = runtime.clock.now();
  const receipt_id = runtime.identifiers.next("receipt");
  const subject_key_id = runtime.identifiers.next("subject");
  const binding_group_id = runtime.identifiers.next("binding");
  const subject_scope = session.scope;
  if (subject_scope.kind !== "named") return Effect.fail(rejected("complete"));
  const digestInput = JSON.stringify({
    proof_session_id: session.id,
    subject: output.subject,
    claims: output,
  });
  return Effect.gen(function* () {
    const subject_digest = yield* runtime.digest
      .digest(output.subject)
      .pipe(Effect.flatMap(decodeDigest));
    const evidence_hash = yield* runtime.digest
      .digest(digestInput)
      .pipe(Effect.flatMap(decodeDigest));
    const assertions = requirements
      .map((requirement) =>
        assertionFor(
          requirement.claim_id,
          requirement,
          output,
          runtime.identifiers,
          observed_at,
          subject_key_id,
          receipt_id,
          binding_group_id,
        ),
      )
      .filter((assertion): assertion is Assertion => assertion !== undefined);
    return {
      id: runtime.identifiers.next("bundle"),
      proof_session_id: session.id,
      receipts: [
        {
          id: receipt_id,
          proof_session_id: session.id,
          provider_id: SELF_ENTERPRISE_PROVIDER_ID,
          issuer: subject_scope.issuer,
          method: session.method,
          scope: subject_scope,
          provider_configuration: session.provider_configuration,
          protocol_version: session.protocol_version,
          environment: session.environment,
          provenance_kind: "proof_session" as const,
          evidence_kind: "self.enterprise",
          evidence_hash,
          observed_at,
          subject_key_id,
        },
      ],
      subject_keys: [
        {
          id: subject_key_id,
          issuer: subject_scope.issuer,
          method: session.method,
          scope: subject_scope,
          subject_digest,
        },
      ],
      binding_groups: [{ id: binding_group_id, kind: "same_subject" as const, subject_key_id }],
      assertions,
    } satisfies EvidenceBundle;
  });
}

function validateClaims(
  session: ProofSession,
  output: SelfEnterpriseVerifiedOutput,
): Effect.Effect<void, VerificationProviderRejected> {
  if (output.session_id !== session.id) return Effect.fail(rejected("complete"));
  for (const requirement of session.requested_requirements) {
    switch (requirement.claim_id) {
      case "credential.subject_unique":
        if (!output.subject_unique) return Effect.fail(rejected("complete"));
        break;
      case "document.valid":
        if (!output.document_valid) return Effect.fail(rejected("complete"));
        break;
      case "document.holder_bound":
        if (!output.holder_bound) return Effect.fail(rejected("complete"));
        break;
      case "age.minimum":
        if (!minimumAgeMeets(output.minimum_age, requirement.minimum_age)) {
          return Effect.fail(rejected("complete"));
        }
        break;
      case "nationality.allowed":
        if (output.nationality_allowed !== true) return Effect.fail(rejected("complete"));
        if (
          output.nationality !== undefined &&
          requirement.allowed_countries.includes(output.nationality) === false
        ) {
          return Effect.fail(rejected("complete"));
        }
        break;
      case "gender.marker":
        if (output.gender === undefined || !requirement.allowed_markers.includes(output.gender)) {
          return Effect.fail(rejected("complete"));
        }
        break;
      default:
        return Effect.fail(rejected("complete"));
    }
  }
  return Effect.succeed(undefined);
}

function makeSession(
  input: VerificationProviderStartInput,
  start: SelfEnterpriseStart,
  flow: SelfEnterpriseFlow,
  runtime: Pick<SelfEnterpriseAdapterOptions, "clock" | "identifiers">,
): ProviderSessionStart {
  const id = runtime.identifiers.next("session");
  const started_at = runtime.clock.now();
  const session: ProofSession = {
    id,
    actor_id: input.actor_id,
    intent_id: input.intent_id,
    request_hash: input.request_hash,
    provider_id: SELF_ENTERPRISE_PROVIDER_ID,
    upstream_session_ref: start.upstream_session_ref,
    provider_configuration: input.provider_configuration,
    method: input.method,
    scope: input.scope,
    request_mode: input.request_mode,
    requested_requirements: input.requested_requirements,
    requested_claim_ids: input.requested_claim_ids,
    subject_binding_intent: input.subject_binding_intent,
    protocol_version: input.protocol_version,
    environment: input.environment,
    status: "pending",
    started_at,
    expires_at: runtime.clock.expiresAt(started_at),
  };
  return {
    session,
    presentation: {
      kind: "embedded_sdk",
      session_id: id,
      protocol: flow.presentation_protocol,
      version: flow.presentation_version,
      payload: start.presentation_payload,
    },
  };
}

export function makeSelfEnterpriseProvider(
  options: SelfEnterpriseAdapterOptions,
): VerificationProviderAdapter {
  const { flows, transport, clock, identifiers, digest } = options;
  return {
    manifest: SELF_ENTERPRISE_MANIFEST,
    plan: (input) => {
      if (flows === undefined) return Effect.succeed({ status: "unknown" as const });
      const flow = findFlow(flows, input);
      return flow === undefined
        ? Effect.succeed({ status: "unsupported" as const })
        : Effect.succeed({
            status: "supported" as const,
            request_mode: "curated" as const,
            provider_configuration: flow.configuration,
          });
    },
    start: (input) => {
      const flow = findFlow(flows, input);
      if (
        flow === undefined ||
        !sameConfiguration(flow.configuration, input.provider_configuration)
      ) {
        return Effect.fail(rejected("start"));
      }
      return transport.start({ request: input, flow }).pipe(
        Effect.flatMap(decodeStart),
        Effect.map((start) => makeSession(input, start, flow, { clock, identifiers })),
      );
    },
    complete: (input: VerificationProviderCompleteInput) => {
      if (
        input.session.provider_id !== SELF_ENTERPRISE_PROVIDER_ID ||
        input.session.request_mode !== "curated" ||
        input.session.provider_configuration.kind !== "managed"
      ) {
        return Effect.fail(rejected("complete"));
      }
      const flow = flows?.find((candidate) => flowMatchesSession(candidate, input.session));
      if (flow === undefined) return Effect.fail(rejected("complete"));
      if (input.submission.channel !== "client_result") return Effect.fail(rejected("complete"));
      return decodeSubmission(input.submission.payload).pipe(
        Effect.filterOrFail(
          (submission) => submission.session_id === input.session.id,
          () => rejected("complete"),
        ),
        Effect.flatMap((submission) =>
          transport.verify({ session: input.session, flow, submission }),
        ),
        Effect.flatMap(decodeVerified),
        Effect.flatMap((output) => validateClaims(input.session, output).pipe(Effect.as(output))),
        Effect.flatMap((output) =>
          evidenceBundle(input.session, output, input.session.requested_requirements, {
            clock,
            identifiers,
            digest,
          }),
        ),
      );
    },
  };
}
