import {
  type ProviderSessionStart,
  type VerificationProviderAdapter,
  type VerificationProviderCompleteInput,
  type VerificationProviderFailure,
  VerificationProviderInvalidResponse,
  VerificationProviderMisconfigured,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
  VerificationProviderUnavailable,
  VerificationProviderUnboundRejected,
} from "@pirate/application/verification";
import {
  type Assertion,
  type CanonicalClaimIdentifier,
  type CanonicalIsoInstant,
  type EvidenceBundle,
  type Iso3166Alpha2,
  type ProofProviderManifest,
  type ProofSession,
  type ProviderConfigurationRef,
  Sha256Hex,
  type SubjectScope,
  type VerificationRequirement,
} from "@pirate/domain/verification";
import { Effect, Option, Schema } from "effect";
import { selfCountryAlpha3 } from "./self-country-codes.ts";

/** ZKPassport SDK 0.14.2 is the reviewed-compatible query/verifier contract. */
export const ZKPASSPORT_PROVIDER_ID = "zkpassport" as const;
export const ZKPASSPORT_PROTOCOL_VERSION = "zkpassport-v2" as const;
export const ZKPASSPORT_PRESENTATION_PROTOCOL = "zkpassport" as const;
export const ZKPASSPORT_PRESENTATION_VERSION = "0.14.2" as const;
export const ZKPASSPORT_RP_SCOPE = "pirate-social" as const;
export const ZKPASSPORT_CONFIGURATION_REFERENCE = "zkpassport.dynamic-query" as const;
export const ZKPASSPORT_CONFIGURATION_VERSION = "query-v1;sdk-0.14.2;verifier-v1" as const;
export const ZKPASSPORT_DEFAULT_VALIDITY_SECONDS = 3_600;
export const ZKPASSPORT_DEFAULT_TIMEOUT_MS = 30_000;
export const ZKPASSPORT_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const ZKPASSPORT_MAX_RESPONSE_BYTES = 64 * 1024;

const ZKPASSPORT_CLAIMS = [
  "age.minimum",
  "credential.subject_unique",
  "document.valid",
  "nationality.allowed",
] as const satisfies readonly CanonicalClaimIdentifier[];

export const ZKPASSPORT_MANIFEST: Schema.Schema.Type<typeof ProofProviderManifest> = {
  provider_id: ZKPASSPORT_PROVIDER_ID,
  manifest_version: "1",
  operation_deadlines: {
    plan_ms: 1_000,
    start_ms: 1_000,
    complete_ms: 120_000,
    callback_ms: 1_000,
  },
  callback_mode: "none",
  callback_header_allowlist: [],
  protocol_versions: [ZKPASSPORT_PROTOCOL_VERSION],
  environments: ["test", "development", "staging", "production"],
  supported_methods: ["document"],
  claim_ids: [...ZKPASSPORT_CLAIMS],
  claim_capabilities: ZKPASSPORT_CLAIMS.map((claim_id) => ({
    claim_id,
    request_modes: ["dynamic" as const],
  })),
  presentation_kinds: ["embedded_sdk"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

type JsonObject = Record<string, unknown>;
type ZkPassportQuery = JsonObject;

export type ZkPassportVerifierInput = Readonly<{
  readonly domain: string;
  readonly proofs: readonly unknown[];
  readonly original_query: ZkPassportQuery;
  readonly query_result: JsonObject;
  readonly validity_seconds: number;
  readonly scope: string;
  readonly dev_mode: boolean;
}>;

export type ZkPassportVerifierResult = Readonly<{
  readonly verified: boolean;
  readonly unique_identifier: string | null;
  /** SDK 0.14.2 returns NullifierType numeric enum values. */
  readonly unique_identifier_type: 0 | null;
}>;

export type ZkPassportVerifierTransport = Readonly<{
  readonly verify: (
    input: ZkPassportVerifierInput,
  ) => Effect.Effect<ZkPassportVerifierResult, VerificationProviderFailure>;
}>;

export type ZkPassportClock = Readonly<{
  readonly now: () => CanonicalIsoInstant;
  readonly expiresAt: (now: CanonicalIsoInstant) => CanonicalIsoInstant;
}>;

export type ZkPassportIdentifiers = Readonly<{
  readonly next: (
    kind: "session" | "bundle" | "receipt" | "subject" | "binding" | "assertion",
  ) => string;
}>;

export type ZkPassportDigest = Readonly<{
  readonly digest: (value: string) => Effect.Effect<string, VerificationProviderFailure>;
}>;

export type ZkPassportAdapterOptions = Readonly<{
  readonly domain: string;
  readonly name: string;
  readonly logo?: string;
  readonly verifier: ZkPassportVerifierTransport;
  readonly clock: ZkPassportClock;
  readonly identifiers: ZkPassportIdentifiers;
  readonly digest: ZkPassportDigest;
  readonly validity_seconds?: number;
  /** Development/test only. Registry composition must never set this in production. */
  readonly dev_mode?: boolean;
}>;

const ZkPassportSubmission = Schema.Struct({
  proofs: Schema.Array(Schema.Json),
  queryResult: Schema.Record(Schema.String, Schema.Json),
});
type DecodedZkPassportSubmission = Schema.Schema.Type<typeof ZkPassportSubmission>;

const VerifierResult = Schema.Struct({
  verified: Schema.Boolean,
  uniqueIdentifier: Schema.NullOr(Schema.String),
  uniqueIdentifierType: Schema.NullOr(Schema.Literal(0)),
});

function invalid(operation: "plan" | "start" | "complete"): VerificationProviderInvalidResponse {
  return new VerificationProviderInvalidResponse({
    provider_id: ZKPASSPORT_PROVIDER_ID,
    operation,
  });
}

function rejected(operation: "start" | "complete"): VerificationProviderRejected {
  return new VerificationProviderRejected({ provider_id: ZKPASSPORT_PROVIDER_ID, operation });
}

function unbound(): VerificationProviderUnboundRejected {
  return new VerificationProviderUnboundRejected({
    provider_id: ZKPASSPORT_PROVIDER_ID,
    operation: "complete",
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

function fixedScope(scope: SubjectScope): boolean {
  return (
    scope.kind === "named" &&
    scope.scope_semantics === "issuer_rp_scope" &&
    scope.issuer === ZKPASSPORT_PROVIDER_ID &&
    scope.rp_scope === ZKPASSPORT_RP_SCOPE
  );
}

function claimIds(
  requirements: readonly VerificationRequirement[],
): readonly CanonicalClaimIdentifier[] {
  return requirements.map((requirement) => requirement.claim_id);
}

function supportedRequirements(requirements: readonly VerificationRequirement[]): boolean {
  return requirements.every((requirement) => {
    if (!ZKPASSPORT_CLAIMS.some((claim) => claim === requirement.claim_id)) return false;
    return (
      requirement.claim_id !== "nationality.allowed" || alpha3Countries(requirement) !== undefined
    );
  });
}

function validEnvironment(environment: string): boolean {
  return ZKPASSPORT_MANIFEST.environments.includes(
    environment as (typeof ZKPASSPORT_MANIFEST.environments)[number],
  );
}

function sameClaims(
  input: Pick<VerificationProviderStartInput, "requested_requirements" | "requested_claim_ids">,
): boolean {
  return (
    JSON.stringify(claimIds(input.requested_requirements)) ===
    JSON.stringify(input.requested_claim_ids)
  );
}

function configuredValidity(options: ZkPassportAdapterOptions): number {
  return options.validity_seconds ?? ZKPASSPORT_DEFAULT_VALIDITY_SECONDS;
}

function validDomain(domain: string): boolean {
  if (domain.length === 0 || domain.trim() !== domain || domain.toLowerCase() !== domain)
    return false;
  try {
    const parsed = new URL(`https://${domain}`);
    return (
      parsed.hostname === domain &&
      parsed.port === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

type ZkPassportVerificationSettings = Readonly<{
  readonly domain: string;
  readonly validity_seconds: number;
  readonly dev_mode: boolean;
}>;

export function zkPassportConfiguration(
  options: Pick<ZkPassportAdapterOptions, "domain" | "validity_seconds" | "dev_mode">,
): ProviderConfigurationRef {
  const validity = options.validity_seconds ?? ZKPASSPORT_DEFAULT_VALIDITY_SECONDS;
  return {
    kind: "dynamic",
    reference: `${ZKPASSPORT_CONFIGURATION_REFERENCE};domain=${encodeURIComponent(options.domain)};mode=${options.dev_mode === true ? "dev" : "live"};validity=${validity}`,
    version: ZKPASSPORT_CONFIGURATION_VERSION,
  };
}

function settingsFromConfiguration(
  configuration: ProviderConfigurationRef,
): ZkPassportVerificationSettings | undefined {
  if (
    configuration.kind !== "dynamic" ||
    configuration.version !== ZKPASSPORT_CONFIGURATION_VERSION
  )
    return undefined;
  const parts = configuration.reference.split(";");
  if (parts.length !== 4 || parts[0] !== ZKPASSPORT_CONFIGURATION_REFERENCE) return undefined;
  const encodedDomain = parts[1]?.startsWith("domain=")
    ? parts[1].slice("domain=".length)
    : undefined;
  const mode = parts[2]?.startsWith("mode=") ? parts[2].slice("mode=".length) : undefined;
  const validityText = parts[3]?.startsWith("validity=")
    ? parts[3].slice("validity=".length)
    : undefined;
  if (
    encodedDomain === undefined ||
    validityText === undefined ||
    (mode !== "dev" && mode !== "live")
  )
    return undefined;
  let domain: string;
  try {
    domain = decodeURIComponent(encodedDomain);
  } catch {
    return undefined;
  }
  const validity_seconds = Number(validityText);
  if (!validDomain(domain) || !Number.isSafeInteger(validity_seconds) || validity_seconds <= 0)
    return undefined;
  return { domain, validity_seconds, dev_mode: mode === "dev" };
}

function alpha3Countries(
  requirement: Extract<VerificationRequirement, { claim_id: "nationality.allowed" }>,
): string[] | undefined {
  const converted = requirement.allowed_countries.map((country: Iso3166Alpha2) =>
    selfCountryAlpha3(country),
  );
  if (converted.some((country) => country === undefined)) return undefined;
  return converted
    .filter((country): country is string => country !== undefined)
    .sort((left, right) => left.localeCompare(right));
}

function bindingFor(session: Pick<ProofSession, "id" | "request_hash">): string {
  // Property order is part of the signed custom_data contract.
  return JSON.stringify({ proof_session_id: session.id, request_hash: session.request_hash });
}

export function compileZkPassportQuery(
  input: Readonly<{
    readonly session_id: string;
    readonly request_hash: string;
    readonly requested_requirements: readonly VerificationRequirement[];
  }>,
): ZkPassportQuery {
  const query: ZkPassportQuery = {
    bind: { custom_data: bindingFor({ id: input.session_id, request_hash: input.request_hash }) },
  };
  for (const requirement of input.requested_requirements) {
    if (requirement.claim_id === "age.minimum") {
      query.age = { gte: Number(requirement.minimum_age) };
    }
    if (requirement.claim_id === "nationality.allowed") {
      const countries = alpha3Countries(requirement);
      if (countries === undefined) throw new Error("unsupported nationality country");
      query.nationality = { in: countries };
    }
  }
  return query;
}

function readRecord(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function strictSubmission(
  value: unknown,
): Effect.Effect<DecodedZkPassportSubmission, VerificationProviderUnboundRejected> {
  const record = readRecord(value);
  if (
    record === undefined ||
    Object.keys(record).some((key) => key !== "proofs" && key !== "queryResult")
  ) {
    return Effect.fail(unbound());
  }
  const decoded = Schema.decodeUnknownOption(ZkPassportSubmission)(value);
  if (
    Option.isNone(decoded) ||
    decoded.value.proofs.length === 0 ||
    decoded.value.proofs.length > 64
  ) {
    return Effect.fail(unbound());
  }
  let bodyBytes = 0;
  try {
    bodyBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Effect.fail(unbound());
  }
  return bodyBytes > ZKPASSPORT_MAX_BODY_BYTES
    ? Effect.fail(unbound())
    : Effect.succeed(decoded.value);
}

function queryResultBinding(queryResult: JsonObject): string | undefined {
  return readRecord(queryResult.bind)?.custom_data as string | undefined;
}

function resultBoolean(value: unknown): boolean {
  return readRecord(value)?.result === true;
}

function resultExpected(value: unknown): unknown {
  return readRecord(value)?.expected;
}

function exactPredicateChecks(session: ProofSession, queryResult: JsonObject): boolean {
  const query = compileZkPassportQuery({
    session_id: session.id,
    request_hash: session.request_hash,
    requested_requirements: session.requested_requirements,
  });
  for (const requirement of session.requested_requirements) {
    if (requirement.claim_id === "age.minimum") {
      const age = readRecord(queryResult.age);
      const expectedAge = Number(requirement.minimum_age);
      if (!resultBoolean(age?.gte) || resultExpected(age?.gte) !== expectedAge) return false;
      if (JSON.stringify(query.age) !== JSON.stringify({ gte: expectedAge })) return false;
    }
    if (requirement.claim_id === "nationality.allowed") {
      const countries = alpha3Countries(requirement);
      const nationality = readRecord(queryResult.nationality);
      if (countries === undefined || !resultBoolean(nationality?.in)) return false;
      if (JSON.stringify(resultExpected(nationality?.in)) !== JSON.stringify(countries))
        return false;
      if (JSON.stringify(query.nationality) !== JSON.stringify({ in: countries })) return false;
    }
  }
  return true;
}

function queryResultBound(session: ProofSession, queryResult: JsonObject): boolean {
  return queryResultBinding(queryResult) === bindingFor(session);
}

function decodeVerifierResult(
  value: unknown,
): Effect.Effect<ZkPassportVerifierResult, VerificationProviderInvalidResponse> {
  const decoded = Schema.decodeUnknownOption(VerifierResult)(value);
  if (Option.isNone(decoded)) return Effect.fail(invalid("complete"));
  return Effect.succeed({
    verified: decoded.value.verified,
    unique_identifier: decoded.value.uniqueIdentifier,
    unique_identifier_type: decoded.value.uniqueIdentifierType,
  });
}

type ZkPassportRequestInput = Pick<
  VerificationProviderStartInput,
  | "method"
  | "scope"
  | "requested_requirements"
  | "requested_claim_ids"
  | "subject_binding_intent"
  | "protocol_version"
  | "environment"
> &
  Partial<Pick<VerificationProviderStartInput, "request_mode" | "provider_configuration">>;

function normalizeInput(input: ZkPassportRequestInput, options: ZkPassportAdapterOptions): boolean {
  return (
    input.method === "document" &&
    fixedScope(input.scope) &&
    (input.request_mode === undefined || input.request_mode === "dynamic") &&
    (input.provider_configuration === undefined ||
      sameConfiguration(input.provider_configuration, zkPassportConfiguration(options))) &&
    supportedRequirements(input.requested_requirements) &&
    sameClaims(input) &&
    input.subject_binding_intent !== "none" &&
    input.protocol_version === ZKPASSPORT_PROTOCOL_VERSION &&
    validEnvironment(input.environment) &&
    validDomain(options.domain) &&
    Number.isSafeInteger(configuredValidity(options)) &&
    configuredValidity(options) > 0 &&
    options.name.length > 0 &&
    options.name.trim() === options.name &&
    (input.environment === "production" ? options.dev_mode !== true : true)
  );
}

function assertionFor(
  requirement: VerificationRequirement,
  observed_at: CanonicalIsoInstant,
  ids: ZkPassportIdentifiers,
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
  switch (requirement.claim_id) {
    case "credential.subject_unique":
      return { ...common, claim_id: requirement.claim_id, value: { subject_unique: true } };
    case "document.valid":
      return { ...common, claim_id: requirement.claim_id, value: { valid: true } };
    case "age.minimum":
      return {
        ...common,
        claim_id: requirement.claim_id,
        value: { minimum_age: requirement.minimum_age },
      };
    case "nationality.allowed":
      return { ...common, claim_id: requirement.claim_id, value: { allowed: true } };
    default:
      return undefined;
  }
}

function evidenceBundle(
  session: ProofSession,
  uniqueIdentifier: string,
  observed_at: CanonicalIsoInstant,
  runtime: Pick<ZkPassportAdapterOptions, "identifiers" | "digest">,
): Effect.Effect<EvidenceBundle, VerificationProviderFailure> {
  if (session.scope.kind !== "named") return Effect.fail(rejected("complete"));
  const scope = session.scope;
  const receipt_id = runtime.identifiers.next("receipt");
  const subject_key_id = runtime.identifiers.next("subject");
  const binding_group_id = runtime.identifiers.next("binding");
  return Effect.gen(function* () {
    // The raw identifier is used only as input to the digest and never enters
    // a receipt, assertion, log, or provider-neutral response.
    const subject_digest = yield* runtime.digest.digest(uniqueIdentifier).pipe(
      Effect.flatMap((value) => {
        const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
        return Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(invalid("complete"));
      }),
    );
    const evidence_hash_input = JSON.stringify({
      proof_session_id: session.id,
      request_hash: session.request_hash,
      provider_configuration: session.provider_configuration,
      subject_digest,
      requested_requirements: session.requested_requirements,
    });
    const evidence_hash = yield* runtime.digest.digest(evidence_hash_input).pipe(
      Effect.flatMap((value) => {
        const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
        return Option.isSome(decoded)
          ? Effect.succeed(decoded.value)
          : Effect.fail(invalid("complete"));
      }),
    );
    const assertions = session.requested_requirements
      .map((requirement) =>
        assertionFor(
          requirement,
          observed_at,
          runtime.identifiers,
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
          provider_id: ZKPASSPORT_PROVIDER_ID,
          issuer: scope.issuer,
          method: session.method,
          scope,
          provider_configuration: session.provider_configuration,
          protocol_version: session.protocol_version,
          environment: session.environment,
          provenance_kind: "proof_session" as const,
          evidence_kind: "zkpassport.document",
          evidence_hash,
          metadata: { unique_identifier_type: "non-salted" },
          observed_at,
          subject_key_id,
        },
      ],
      subject_keys: [
        {
          id: subject_key_id,
          issuer: scope.issuer,
          method: session.method,
          scope,
          subject_digest,
        },
      ],
      binding_groups: [{ id: binding_group_id, kind: "same_subject" as const, subject_key_id }],
      assertions,
    } satisfies EvidenceBundle;
  });
}

function makeSession(
  input: VerificationProviderStartInput,
  runtime: Pick<ZkPassportAdapterOptions, "clock" | "identifiers">,
  options: ZkPassportAdapterOptions,
): ProviderSessionStart {
  const id = runtime.identifiers.next("session");
  const started_at = runtime.clock.now();
  const session: ProofSession = {
    id,
    actor_id: input.actor_id,
    intent_id: input.intent_id,
    request_hash: input.request_hash,
    provider_id: ZKPASSPORT_PROVIDER_ID,
    upstream_session_ref: id,
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
  const query = compileZkPassportQuery({
    session_id: id,
    request_hash: input.request_hash,
    requested_requirements: input.requested_requirements,
  });
  const payload = {
    domain: options.domain,
    name: options.name,
    ...(options.logo === undefined ? {} : { logo: options.logo }),
    purpose: "Verify document attributes for Pirate community access",
    scope: ZKPASSPORT_RP_SCOPE,
    validity_seconds: configuredValidity(options),
    dev_mode: options.dev_mode === true,
    unique_identifier_type: 0,
    // Keep the SDK's camel-case request option in the client instructions;
    // the snake-case alias is retained as a wire-readable description.
    uniqueIdentifierType: 0,
    request: {
      name: options.name,
      ...(options.logo === undefined ? {} : { logo: options.logo }),
      purpose: "Verify document attributes for Pirate community access",
      scope: ZKPASSPORT_RP_SCOPE,
      validity: configuredValidity(options),
      devMode: options.dev_mode === true,
      uniqueIdentifierType: 0,
    },
    query,
  };
  return {
    session,
    presentation: {
      kind: "embedded_sdk",
      session_id: id,
      protocol: ZKPASSPORT_PRESENTATION_PROTOCOL,
      version: ZKPASSPORT_PRESENTATION_VERSION,
      payload: payload as Schema.Schema.Type<typeof Schema.Json>,
    },
  };
}

export function makeZkPassportProvider(
  options: ZkPassportAdapterOptions,
): VerificationProviderAdapter {
  const configuration = zkPassportConfiguration(options);
  return {
    manifest: ZKPASSPORT_MANIFEST,
    plan: (input) => {
      if (!normalizeInput(input, options))
        return Effect.succeed({ status: "unsupported" as const });
      return Effect.succeed({
        status: "supported" as const,
        request_mode: "dynamic" as const,
        provider_configuration: configuration,
      });
    },
    start: (input) => {
      if (!normalizeInput(input, options)) return Effect.fail(rejected("start"));
      try {
        return Effect.succeed(makeSession(input, options, options));
      } catch {
        return Effect.fail(invalid("start"));
      }
    },
    complete: (input: VerificationProviderCompleteInput) => {
      const verifierSettings = settingsFromConfiguration(input.session.provider_configuration);
      if (
        input.session.provider_id !== ZKPASSPORT_PROVIDER_ID ||
        input.session.method !== "document" ||
        input.session.request_mode !== "dynamic" ||
        verifierSettings === undefined ||
        !fixedScope(input.session.scope) ||
        input.session.protocol_version !== ZKPASSPORT_PROTOCOL_VERSION ||
        !supportedRequirements(input.session.requested_requirements) ||
        !sameClaims(input.session) ||
        input.session.subject_binding_intent === "none" ||
        (input.session.environment === "production" && verifierSettings.dev_mode)
      )
        return Effect.fail(unbound());
      if (input.submission.channel !== "client_result") return Effect.fail(unbound());
      return strictSubmission(input.submission.payload).pipe(
        Effect.flatMap((submission) => {
          const queryResult = submission.queryResult as JsonObject;
          // This is checked before any verifier work. The client cannot select
          // an originalQuery; it is regenerated from the persisted session.
          if (!queryResultBound(input.session, queryResult)) return Effect.fail(unbound());
          let originalQuery: ZkPassportQuery;
          try {
            originalQuery = compileZkPassportQuery({
              session_id: input.session.id,
              request_hash: input.session.request_hash,
              requested_requirements: input.session.requested_requirements,
            });
          } catch {
            return Effect.fail(invalid("complete"));
          }
          return options.verifier
            .verify({
              domain: verifierSettings.domain,
              proofs: [...submission.proofs],
              original_query: originalQuery,
              query_result: queryResult,
              validity_seconds: verifierSettings.validity_seconds,
              scope: ZKPASSPORT_RP_SCOPE,
              dev_mode: verifierSettings.dev_mode,
            })
            .pipe(
              Effect.flatMap((result) => {
                if (!result.verified) return Effect.fail(unbound());
                if (
                  result.unique_identifier_type !== 0 ||
                  result.unique_identifier === null ||
                  result.unique_identifier.trim() === ""
                ) {
                  return Effect.fail(invalid("complete"));
                }
                if (!exactPredicateChecks(input.session, queryResult))
                  return Effect.fail(rejected("complete"));
                return evidenceBundle(
                  input.session,
                  result.unique_identifier,
                  options.clock.now(),
                  options,
                );
              }),
            );
        }),
      );
    },
  };
}

async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw invalid("complete");
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw invalid("complete");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw invalid("complete");
  }
}

/** Strict authenticated transport for the separate Node/Bun verifier service. */
export function makeZkPassportVerifierTransport(
  options: Readonly<{
    readonly endpoint: string;
    readonly shared_secret: string;
    readonly timeout_ms?: number;
    readonly fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  }>,
): ZkPassportVerifierTransport {
  const endpoint = options.endpoint.trim();
  const secret = options.shared_secret.trim();
  const timeout_ms = options.timeout_ms ?? ZKPASSPORT_DEFAULT_TIMEOUT_MS;
  let endpointUrl: URL | undefined;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    endpointUrl = undefined;
  }
  const loopback =
    endpointUrl?.hostname === "localhost" ||
    endpointUrl?.hostname === "127.0.0.1" ||
    endpointUrl?.hostname === "[::1]";
  const validEndpoint =
    endpointUrl !== undefined &&
    endpointUrl.username === "" &&
    endpointUrl.password === "" &&
    endpointUrl.hash === "" &&
    (endpointUrl.protocol === "https:" || (endpointUrl.protocol === "http:" && loopback));
  if (!validEndpoint || !secret || !Number.isSafeInteger(timeout_ms) || timeout_ms <= 0) {
    return {
      verify: () =>
        Effect.fail(
          new VerificationProviderMisconfigured({
            provider_id: ZKPASSPORT_PROVIDER_ID,
            operation: "complete",
          }),
        ),
    };
  }
  return {
    verify: (input) =>
      Effect.tryPromise({
        try: async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), timeout_ms);
          let response: Response;
          try {
            const body = JSON.stringify({
              domain: input.domain,
              proofs: input.proofs,
              originalQuery: input.original_query,
              queryResult: input.query_result,
              validity: input.validity_seconds,
              scope: input.scope,
              devMode: input.dev_mode,
            });
            if (new TextEncoder().encode(body).byteLength > ZKPASSPORT_MAX_BODY_BYTES) {
              throw new VerificationProviderInvalidResponse({
                provider_id: ZKPASSPORT_PROVIDER_ID,
                operation: "complete",
              });
            }
            response = await (options.fetcher ?? fetch)(endpoint, {
              method: "POST",
              headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
              body,
              signal: controller.signal,
            });
            if (response.status === 401 || response.status === 403) {
              throw new VerificationProviderMisconfigured({
                provider_id: ZKPASSPORT_PROVIDER_ID,
                operation: "complete",
              });
            }
            if (response.status === 400 || response.status === 413) throw unbound();
            if (response.status === 408 || response.status === 429 || response.status >= 500) {
              if (response.status === 503) {
                const value = await readBoundedJson(response, ZKPASSPORT_MAX_RESPONSE_BYTES);
                if (readRecord(value)?.code === "not_configured") {
                  throw new VerificationProviderMisconfigured({
                    provider_id: ZKPASSPORT_PROVIDER_ID,
                    operation: "complete",
                  });
                }
              }
              throw new VerificationProviderUnavailable({
                provider_id: ZKPASSPORT_PROVIDER_ID,
                operation: "complete",
              });
            }
            if (!response.ok) throw invalid("complete");
            return await readBoundedJson(response, ZKPASSPORT_MAX_RESPONSE_BYTES);
          } finally {
            clearTimeout(timer);
          }
        },
        catch: (error) => {
          if (
            error instanceof VerificationProviderMisconfigured ||
            error instanceof VerificationProviderUnavailable ||
            error instanceof VerificationProviderInvalidResponse ||
            error instanceof VerificationProviderUnboundRejected
          )
            return error;
          return new VerificationProviderUnavailable({
            provider_id: ZKPASSPORT_PROVIDER_ID,
            operation: "complete",
          });
        },
      }).pipe(Effect.flatMap((value) => decodeVerifierResult(value))),
  };
}
