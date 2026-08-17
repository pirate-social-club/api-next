import {
  type ProviderSessionStart,
  type VerificationProviderAdapter,
  type VerificationProviderCallbackInput,
  type VerificationProviderCallbackResolution,
  type VerificationProviderCompleteInput,
  type VerificationProviderFailure,
  VerificationProviderInvalidResponse,
  VerificationProviderMisconfigured,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
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
import type { AttestationId, VerificationConfig } from "@selfxyz/core";
import { Effect, Option, Schema } from "effect";
import { normalizeSelfCountry } from "./self-country-codes.ts";

/**
 * Self Pass is deliberately separate from the exploratory Self Enterprise
 * adapter.  It is the open-source, dynamically compiled SelfBackendVerifier
 * ceremony that runs inside the HTTP Worker.
 */
export const SELF_PASS_PROVIDER_ID = "self.pass" as const;
export const SELF_PASS_PROTOCOL_VERSION = "self-pass-v1" as const;
export const SELF_PASS_PRESENTATION_PROTOCOL = "self" as const;
export const SELF_PASS_PRESENTATION_VERSION = "2" as const;
export const SELF_PASS_RP_SCOPE = "pirate-social" as const;
export const SELF_PASS_CONFIGURATION_REFERENCE = "self.pass.disclosure-compiler" as const;
export const SELF_PASS_CONFIGURATION_VERSION = "1.2.0-beta.1" as const;

export function selfPassConfigurationFor(
  callback_origin: string,
  mock_passport: boolean,
): ProviderConfigurationRef {
  return {
    kind: "dynamic",
    reference: `${SELF_PASS_CONFIGURATION_REFERENCE};mode=${mock_passport ? "mock" : "live"};origin=${encodeURIComponent(callback_origin)}`,
    version: SELF_PASS_CONFIGURATION_VERSION,
  };
}

/** Self Pass cannot prove face match or liveness, so holder binding is not claimed. */
const SELF_PASS_CLAIMS = [
  "age.minimum",
  "credential.subject_unique",
  "document.valid",
  "gender.marker",
  "nationality.allowed",
] as const satisfies readonly CanonicalClaimIdentifier[];

export const SELF_PASS_MANIFEST: Schema.Schema.Type<typeof ProofProviderManifest> = {
  provider_id: SELF_PASS_PROVIDER_ID,
  manifest_version: "1",
  operation_deadlines: {
    plan_ms: 1_000,
    start_ms: 1_000,
    complete_ms: 120_000,
    callback_ms: 1_000,
  },
  callback_mode: "session_bound_proof",
  callback_header_allowlist: [],
  protocol_versions: [SELF_PASS_PROTOCOL_VERSION],
  environments: ["test", "development", "staging", "production"],
  supported_methods: ["document"],
  claim_ids: [...SELF_PASS_CLAIMS],
  claim_capabilities: SELF_PASS_CLAIMS.map((claim_id) => ({
    claim_id,
    request_modes: ["dynamic" as const],
  })),
  presentation_kinds: ["embedded_sdk"],
  assurance_levels: ["document_zk"],
  subject_key_scope_semantics: "issuer_rp_scope",
};

type SelfCoreModule = typeof import("@selfxyz/core");
type SelfVerifier = InstanceType<SelfCoreModule["SelfBackendVerifier"]>;
export type SelfPassProof = Parameters<SelfVerifier["verify"]>[1];
export type SelfPassPublicSignals = Parameters<SelfVerifier["verify"]>[2];
export type SelfPassVerificationResult = Awaited<ReturnType<SelfVerifier["verify"]>>;

/**
 * The production seam is the actual module returned by the literal dynamic
 * import. Tests inject a structurally identical seam so no global SDK mock is
 * needed and the constructor/verify call remains exactly the SDK call.
 */
export type SelfPassSdk = Readonly<{
  readonly AllIds: SelfCoreModule["AllIds"];
  readonly DefaultConfigStore: SelfCoreModule["DefaultConfigStore"];
  readonly SelfBackendVerifier: SelfCoreModule["SelfBackendVerifier"];
}>;

export type SelfPassClock = Readonly<{
  readonly now: () => CanonicalIsoInstant;
  readonly expiresAt: (now: CanonicalIsoInstant) => CanonicalIsoInstant;
}>;

export type SelfPassIdentifierKind =
  | "session"
  | "bundle"
  | "receipt"
  | "subject"
  | "binding"
  | "assertion";

export type SelfPassIdentifiers = Readonly<{
  readonly next: (kind: SelfPassIdentifierKind) => string;
}>;

export type SelfPassDigest = Readonly<{
  readonly digest: (value: string) => Effect.Effect<string, VerificationProviderFailure>;
}>;

export type SelfPassAdapterOptions = Readonly<{
  /** Public HTTPS origin of this Worker, without the callback path. */
  readonly callback_origin: string;
  readonly app_name: string;
  /** Explicitly selects Self's testnet verifier; production must set false. */
  readonly mock_passport: boolean;
  readonly clock: SelfPassClock;
  readonly identifiers: SelfPassIdentifiers;
  readonly digest: SelfPassDigest;
  /** Optional test seam; production lazily imports the pinned SDK. */
  readonly sdk?: SelfPassSdk;
}>;

const AttestationIdSchema = Schema.Literals([1, 2, 3, 4]);
const SelfBigNumberish = Schema.Union([Schema.String, Schema.Number]);
const SelfProof = Schema.Struct({
  a: Schema.Tuple([SelfBigNumberish, SelfBigNumberish]),
  b: Schema.Tuple([
    Schema.Tuple([SelfBigNumberish, SelfBigNumberish]),
    Schema.Tuple([SelfBigNumberish, SelfBigNumberish]),
  ]),
  c: Schema.Tuple([SelfBigNumberish, SelfBigNumberish]),
});
const SelfPassRequestHash = Sha256Hex;

const SelfCamelSubmission = Schema.Struct({
  kind: Schema.optional(Schema.Literal("self-proof")),
  session_id: Schema.optional(Schema.NonEmptyString),
  attestationId: AttestationIdSchema,
  proof: SelfProof,
  publicSignals: Schema.NonEmptyArray(SelfBigNumberish),
  userContextData: Schema.NonEmptyString,
});

const SelfSnakeSubmission = Schema.Struct({
  kind: Schema.optional(Schema.Literal("self-proof")),
  session_id: Schema.optional(Schema.NonEmptyString),
  attestation_id: AttestationIdSchema,
  proof: SelfProof,
  public_signals: Schema.NonEmptyArray(SelfBigNumberish),
  user_context_data: Schema.NonEmptyString,
});

type CanonicalSelfSubmission = Readonly<{
  readonly kind: "self-proof";
  readonly session_id?: string;
  readonly attestation_id: AttestationId;
  readonly proof: SelfPassProof;
  readonly public_signals: SelfPassPublicSignals;
  readonly user_context_data: string;
}>;

const SelfUserDefinedData = Schema.Struct({
  proof_session_id: Schema.String.check(
    Schema.makeFilter((value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
        ? undefined
        : "Expected a canonical UUID proof-session identifier",
    ),
  ),
  request_hash: SelfPassRequestHash,
});
type SelfUserDefinedData = Schema.Schema.Type<typeof SelfUserDefinedData>;

const SelfResult = Schema.Struct({
  attestationId: AttestationIdSchema,
  isValidDetails: Schema.Struct({
    isValid: Schema.Boolean,
    isMinimumAgeValid: Schema.Boolean,
    isOfacValid: Schema.Boolean,
  }),
  discloseOutput: Schema.Struct({
    nullifier: Schema.String,
    nationality: Schema.String,
    gender: Schema.String,
    expiryDate: Schema.String,
    minimumAge: Schema.optional(Schema.String),
    minimum_age: Schema.optional(Schema.String),
    olderThan: Schema.optional(Schema.String),
  }),
  userData: Schema.Struct({
    userIdentifier: Schema.String,
    userDefinedData: Schema.String,
  }),
});

// beta.1's GenericDiscloseOutput always carries nationality and gender as
// strings; an undisclosed packed field is represented as an empty string, not
// an omitted property. Keep those fields required and validate them only when
// their corresponding requirement was requested.
type DecodedSelfResult = Schema.Schema.Type<typeof SelfResult>;

let selfCoreModulePromise: Promise<SelfPassSdk> | undefined;

function loadSelfPassSdk(): Promise<SelfPassSdk> {
  selfCoreModulePromise ??= import("@selfxyz/core");
  return selfCoreModulePromise;
}

function invalid(operation: "plan" | "start" | "complete" | "callback") {
  return new VerificationProviderInvalidResponse({
    provider_id: SELF_PASS_PROVIDER_ID,
    operation,
  });
}

function rejected(operation: "start" | "complete" | "callback") {
  return new VerificationProviderRejected({
    provider_id: SELF_PASS_PROVIDER_ID,
    operation,
  });
}

function sameConfiguration(left: ProviderConfigurationRef, right: ProviderConfigurationRef) {
  return (
    left.kind === right.kind && left.reference === right.reference && left.version === right.version
  );
}

type SelfPassVerifierSettings = Readonly<{
  readonly callback_origin: string;
  readonly mock_passport: boolean;
}>;

function verifierSettingsFromConfiguration(
  configuration: ProviderConfigurationRef,
): SelfPassVerifierSettings | undefined {
  if (
    configuration.kind !== "dynamic" ||
    configuration.version !== SELF_PASS_CONFIGURATION_VERSION
  ) {
    return undefined;
  }
  const parts = configuration.reference.split(";");
  if (parts.length !== 3 || parts[0] !== SELF_PASS_CONFIGURATION_REFERENCE) return undefined;
  const mode = parts[1]?.startsWith("mode=") ? parts[1].slice("mode=".length) : undefined;
  const encodedOrigin = parts[2]?.startsWith("origin=")
    ? parts[2].slice("origin=".length)
    : undefined;
  if (mode === undefined || encodedOrigin === undefined) return undefined;
  let callback_origin: string;
  try {
    callback_origin = decodeURIComponent(encodedOrigin);
  } catch {
    return undefined;
  }
  if (!validCallbackOrigin(callback_origin)) return undefined;
  if (mode !== "mock" && mode !== "live") return undefined;
  return { callback_origin, mock_passport: mode === "mock" };
}

function sameScope(left: SubjectScope, right: SubjectScope): boolean {
  return (
    left.kind === "named" &&
    right.kind === "named" &&
    left.scope_semantics === "issuer_rp_scope" &&
    right.scope_semantics === "issuer_rp_scope" &&
    left.issuer === SELF_PASS_PROVIDER_ID &&
    right.issuer === SELF_PASS_PROVIDER_ID &&
    left.rp_scope === SELF_PASS_RP_SCOPE &&
    right.rp_scope === SELF_PASS_RP_SCOPE
  );
}

function claimIds(requirements: readonly VerificationRequirement[]) {
  return requirements.map((requirement) => requirement.claim_id);
}

function requirementsSupported(requirements: readonly VerificationRequirement[]): boolean {
  return requirements.every((requirement) =>
    SELF_PASS_CLAIMS.some((claim_id) => claim_id === requirement.claim_id),
  );
}

function fixedScope(input: Pick<VerificationProviderStartInput, "scope">): boolean {
  return sameScope(input.scope, {
    kind: "named",
    scope_semantics: "issuer_rp_scope",
    issuer: SELF_PASS_PROVIDER_ID,
    rp_scope: SELF_PASS_RP_SCOPE,
  });
}

function compileDisclosures(requirements: readonly VerificationRequirement[]) {
  const disclosures: {
    minimum_age?: number;
    nationality?: true;
    gender?: true;
  } = {};
  for (const requirement of requirements) {
    if (requirement.claim_id === "age.minimum")
      disclosures.minimum_age = Number(requirement.minimum_age);
    if (requirement.claim_id === "nationality.allowed") disclosures.nationality = true;
    if (requirement.claim_id === "gender.marker") disclosures.gender = true;
  }
  return disclosures;
}

function compileVerificationConfig(
  requirements: readonly VerificationRequirement[],
): VerificationConfig {
  const age = requirements.find((requirement) => requirement.claim_id === "age.minimum");
  return age?.claim_id === "age.minimum" ? { minimumAge: Number(age.minimum_age) } : {};
}

function callbackEndpoint(origin: string): string {
  return `${origin.replace(/\/$/u, "")}/verification/callbacks/${SELF_PASS_PROVIDER_ID}`;
}

function validCallbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      url.protocol === "https:" && url.pathname === "/" && url.search === "" && url.hash === ""
    );
  } catch {
    return false;
  }
}

function validAppName(appName: string): boolean {
  return appName.length > 0 && appName.length <= 128 && appName.trim() === appName;
}

function endpointType(mockPassport: boolean): "https" | "staging_https" {
  return mockPassport ? "staging_https" : "https";
}

function mockPassportAllowed(environment: string, mockPassport: boolean): boolean {
  return environment !== "production" || !mockPassport;
}

function selfUserIdForRequest(requestHash: string): string {
  const chars = requestHash.slice(0, 32).split("");
  chars[12] = "4";
  const variant = Number.parseInt(chars[16] ?? "8", 16);
  chars[16] = ((variant & 0x3) | 0x8).toString(16);
  return `${chars.slice(0, 8).join("")}-${chars.slice(8, 12).join("")}-${chars.slice(12, 16).join("")}-${chars.slice(16, 20).join("")}-${chars.slice(20).join("")}`;
}

function expectedUserDefinedData(session: ProofSession): SelfUserDefinedData {
  return {
    proof_session_id: session.id,
    request_hash: session.request_hash,
  };
}

function encodeUserDefinedData(value: SelfUserDefinedData): string {
  return JSON.stringify(value);
}

function decodeHexUtf8(value: string): string | undefined {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  if (normalized.length % 2 !== 0 || !/^[0-9a-f]+$/iu.test(normalized)) return undefined;
  try {
    const bytes = new Uint8Array(normalized.length / 2);
    for (let index = 0; index < normalized.length; index += 2) {
      bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeUserDefinedJson(value: string): Option.Option<SelfUserDefinedData> {
  try {
    return Schema.decodeUnknownOption(SelfUserDefinedData)(JSON.parse(value) as unknown);
  } catch {
    return Option.none();
  }
}

function decodeSelfUserDefinedData(value: string): Option.Option<SelfUserDefinedData> {
  const decoded = decodeUserDefinedJson(value);
  if (Option.isSome(decoded)) return decoded;
  const hex = decodeHexUtf8(value);
  if (hex === undefined) return Option.none();
  return decodeUserDefinedJson(hex);
}

function decodeCallbackContext(value: string): Option.Option<SelfUserDefinedData> {
  const normalized = value.startsWith("0x") ? value.slice(2) : value;
  // Self reserves the first 128 hex characters for user identifier/context.
  if (normalized.length <= 128) return Option.none();
  return Option.fromNullishOr(decodeHexUtf8(normalized.slice(128))).pipe(
    Option.flatMap(decodeUserDefinedJson),
  );
}

function normalizeGender(value: string): "female" | "male" | "unspecified" | undefined {
  switch (value.trim().toUpperCase()) {
    case "F":
    case "FEMALE":
      return "female";
    case "M":
    case "MALE":
      return "male";
    case "UNSPECIFIED":
      return "unspecified";
    default:
      return undefined;
  }
}

function minimumAge(result: DecodedSelfResult): string | undefined {
  const value =
    result.discloseOutput.minimumAge ??
    result.discloseOutput.minimum_age ??
    result.discloseOutput.olderThan;
  if (value === undefined || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return undefined;
  return value;
}

function canonicalDocumentExpiry(
  attestationId: AttestationId,
  value: string,
  observedAt: CanonicalIsoInstant,
): string | undefined {
  if (attestationId === 3) return value === "UNAVAILABLE" ? "UNAVAILABLE" : undefined;
  const expectedLength = attestationId === 4 ? 8 : 6;
  if (value.length !== expectedLength || !/^[0-9]+$/u.test(value)) return undefined;

  const observedYear = new Date(observedAt).getUTCFullYear();
  let year: number;
  let monthOffset: number;
  if (expectedLength === 8) {
    year = Number(value.slice(0, 4));
    monthOffset = 4;
  } else {
    year = Math.floor(observedYear / 100) * 100 + Number(value.slice(0, 2));
    // MRZ expiry dates carry two-digit years. Resolve only the bounded window
    // relevant to a live credential; ambiguous far-future values fail closed
    // into the prior century instead of granting decades of extra validity.
    if (year < observedYear - 80) year += 100;
    if (year > observedYear + 20) year -= 100;
    monthOffset = 2;
  }
  const month = Number(value.slice(monthOffset, monthOffset + 2));
  const day = Number(value.slice(monthOffset + 2, monthOffset + 4));
  const expiry = new Date(Date.UTC(year, month - 1, day));
  if (
    expiry.getUTCFullYear() !== year ||
    expiry.getUTCMonth() !== month - 1 ||
    expiry.getUTCDate() !== day
  ) {
    return undefined;
  }
  const canonical = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return canonical >= observedAt.slice(0, 10) ? canonical : undefined;
}

function credentialType(attestationId: AttestationId): string {
  switch (attestationId) {
    case 1:
      return "passport";
    case 2:
      return "biometric_id_card";
    case 3:
      return "aadhaar";
    case 4:
      return "selfrica_id_card";
  }
}

function decodeSubmission(
  value: unknown,
): Effect.Effect<CanonicalSelfSubmission, VerificationProviderRejected> {
  const camel = Schema.decodeUnknownOption(SelfCamelSubmission)(value);
  if (Option.isSome(camel)) {
    return Effect.succeed({
      kind: "self-proof",
      ...(camel.value.session_id === undefined ? {} : { session_id: camel.value.session_id }),
      attestation_id: camel.value.attestationId,
      proof: camel.value.proof as SelfPassProof,
      public_signals: [...camel.value.publicSignals] as SelfPassPublicSignals,
      user_context_data: camel.value.userContextData,
    });
  }
  const snake = Schema.decodeUnknownOption(SelfSnakeSubmission)(value);
  if (Option.isSome(snake)) {
    return Effect.succeed({
      kind: "self-proof",
      ...(snake.value.session_id === undefined ? {} : { session_id: snake.value.session_id }),
      attestation_id: snake.value.attestation_id,
      proof: snake.value.proof as SelfPassProof,
      public_signals: [...snake.value.public_signals] as SelfPassPublicSignals,
      user_context_data: snake.value.user_context_data,
    });
  }
  return Effect.fail(rejected("complete"));
}

function decodeResult(
  value: unknown,
): Effect.Effect<DecodedSelfResult, VerificationProviderInvalidResponse> {
  const decoded = Schema.decodeUnknownOption(SelfResult)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("complete"));
}

function decodeDigest(
  value: string,
): Effect.Effect<Sha256Hex, VerificationProviderInvalidResponse> {
  const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(invalid("complete"));
}

function userDefinedDataMatches(expected: SelfUserDefinedData, received: string): boolean {
  if (received === encodeUserDefinedData(expected)) return true;
  const decoded = decodeSelfUserDefinedData(received);
  return (
    Option.isSome(decoded) &&
    decoded.value.proof_session_id === expected.proof_session_id &&
    decoded.value.request_hash === expected.request_hash
  );
}

function decodeCallbackDigest(
  value: string,
): Effect.Effect<Sha256Hex, VerificationProviderRejected> {
  const decoded = Schema.decodeUnknownOption(Sha256Hex)(value);
  return Option.isSome(decoded) ? Effect.succeed(decoded.value) : Effect.fail(rejected("callback"));
}

type NamedSelfPassScope = Extract<
  SubjectScope,
  { readonly kind: "named"; readonly scope_semantics: "issuer_rp_scope" }
>;

function flowScope(session: ProofSession): NamedSelfPassScope | undefined {
  return session.scope.kind === "named" && session.scope.scope_semantics === "issuer_rp_scope"
    ? session.scope
    : undefined;
}

function assertionFor(
  requirement: VerificationRequirement,
  normalizedGender: "female" | "male" | "unspecified" | undefined,
  ids: SelfPassIdentifiers,
  observedAt: CanonicalIsoInstant,
  subjectKeyId: string,
  receiptId: string,
  bindingGroupId: string,
): Assertion | undefined {
  const common = {
    id: ids.next("assertion"),
    subject_key_id: subjectKeyId,
    evidence_receipt_id: receiptId,
    assurance: "document_zk" as const,
    binding_group_id: bindingGroupId,
    observed_at: observedAt,
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
    case "gender.marker":
      return normalizedGender === undefined
        ? undefined
        : { ...common, claim_id: requirement.claim_id, value: { gender: normalizedGender } };
    default:
      return undefined;
  }
}

function validateClaims(
  session: ProofSession,
  result: DecodedSelfResult,
  observedAt: CanonicalIsoInstant,
): Effect.Effect<
  Readonly<{
    nationality?: Iso3166Alpha2;
    gender?: "female" | "male" | "unspecified";
    minimum_age?: string;
    document_expiry?: string;
  }>,
  VerificationProviderRejected
> {
  if (result.isValidDetails.isValid !== true) return Effect.fail(rejected("complete"));
  const requiresMinimumAge = session.requested_requirements.some(
    (requirement) => requirement.claim_id === "age.minimum",
  );
  if (requiresMinimumAge && result.isValidDetails.isMinimumAgeValid !== true) {
    return Effect.fail(rejected("complete"));
  }
  if (result.userData.userIdentifier !== selfUserIdForRequest(session.request_hash)) {
    return Effect.fail(rejected("complete"));
  }
  const expected = expectedUserDefinedData(session);
  if (!userDefinedDataMatches(expected, result.userData.userDefinedData)) {
    return Effect.fail(rejected("complete"));
  }
  if (result.discloseOutput.nullifier.trim() === "") return Effect.fail(rejected("complete"));

  const age = minimumAge(result);
  const nationality = normalizeSelfCountry(result.discloseOutput.nationality);
  const gender = normalizeGender(result.discloseOutput.gender);
  const documentExpiry = canonicalDocumentExpiry(
    result.attestationId,
    result.discloseOutput.expiryDate,
    observedAt,
  );
  for (const requirement of session.requested_requirements) {
    switch (requirement.claim_id) {
      case "credential.subject_unique":
        break;
      case "document.valid":
        if (documentExpiry === undefined) return Effect.fail(rejected("complete"));
        break;
      case "age.minimum":
        if (age === undefined || BigInt(age) < BigInt(requirement.minimum_age)) {
          return Effect.fail(rejected("complete"));
        }
        break;
      case "nationality.allowed":
        if (nationality === undefined || !requirement.allowed_countries.includes(nationality)) {
          return Effect.fail(rejected("complete"));
        }
        break;
      case "gender.marker":
        if (gender === undefined || !requirement.allowed_markers.includes(gender)) {
          return Effect.fail(rejected("complete"));
        }
        break;
      default:
        return Effect.fail(rejected("complete"));
    }
  }
  return Effect.succeed({
    ...(age === undefined ? {} : { minimum_age: age }),
    ...(nationality === undefined ? {} : { nationality }),
    ...(gender === undefined ? {} : { gender }),
    ...(documentExpiry === undefined ? {} : { document_expiry: documentExpiry }),
  });
}

function evidenceBundle(
  session: ProofSession,
  submission: CanonicalSelfSubmission,
  result: DecodedSelfResult,
  normalized: Readonly<{
    nationality?: Iso3166Alpha2;
    gender?: "female" | "male" | "unspecified";
    minimum_age?: string;
    document_expiry?: string;
  }>,
  observed_at: CanonicalIsoInstant,
  runtime: Pick<SelfPassAdapterOptions, "identifiers" | "digest">,
): Effect.Effect<EvidenceBundle, VerificationProviderFailure> {
  const scope = flowScope(session);
  if (scope === undefined) return Effect.fail(rejected("complete"));
  const receipt_id = runtime.identifiers.next("receipt");
  const subject_key_id = runtime.identifiers.next("subject");
  const binding_group_id = runtime.identifiers.next("binding");
  const output = {
    attestation_id: submission.attestation_id,
    nullifier: result.discloseOutput.nullifier,
    minimum_age: normalized.minimum_age,
    nationality: normalized.nationality,
    gender: normalized.gender,
    document_expiry: normalized.document_expiry,
  };
  const evidence_hash_input = JSON.stringify({
    proof_session_id: session.id,
    request_hash: session.request_hash,
    provider_configuration: session.provider_configuration,
    scope,
    output,
  });
  return Effect.gen(function* () {
    const subject_digest = yield* runtime.digest
      .digest(result.discloseOutput.nullifier)
      .pipe(Effect.flatMap(decodeDigest));
    const evidence_hash = yield* runtime.digest
      .digest(evidence_hash_input)
      .pipe(Effect.flatMap(decodeDigest));
    const assertions = session.requested_requirements
      .map((requirement) =>
        assertionFor(
          requirement,
          normalized.gender,
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
          provider_id: SELF_PASS_PROVIDER_ID,
          issuer: scope.issuer,
          method: session.method,
          scope,
          provider_configuration: session.provider_configuration,
          protocol_version: session.protocol_version,
          environment: session.environment,
          provenance_kind: "proof_session" as const,
          evidence_kind: `self.pass.attestation.${submission.attestation_id}`,
          evidence_hash,
          metadata: {
            credential_type: credentialType(submission.attestation_id),
            source_attestation_id: String(submission.attestation_id),
          },
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
  launch: SelfPassLaunch,
  runtime: Pick<SelfPassAdapterOptions, "clock">,
): ProviderSessionStart {
  const started_at = runtime.clock.now();
  const session: ProofSession = {
    id: launch.session_id,
    actor_id: input.actor_id,
    intent_id: input.intent_id,
    request_hash: input.request_hash,
    provider_id: SELF_PASS_PROVIDER_ID,
    upstream_session_ref: launch.session_id,
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
      session_id: session.id,
      protocol: SELF_PASS_PRESENTATION_PROTOCOL,
      version: SELF_PASS_PRESENTATION_VERSION,
      payload: launch,
    },
  };
}

type SelfPassLaunch = Readonly<{
  readonly app_name: string;
  readonly endpoint: string;
  readonly endpoint_type: "https" | "staging_https";
  readonly scope: typeof SELF_PASS_RP_SCOPE;
  readonly session_id: string;
  readonly user_id: string;
  readonly user_id_type: "uuid";
  readonly disclosures: ReturnType<typeof compileDisclosures>;
  readonly dev_mode: boolean;
  readonly user_defined_data: string;
  readonly version: 2;
}>;

export function makeSelfPassProvider(options: SelfPassAdapterOptions): VerificationProviderAdapter {
  const provider = {
    manifest: SELF_PASS_MANIFEST,
    plan: (input) => {
      if (
        input.method !== "document" ||
        !fixedScope(input) ||
        !requirementsSupported(input.requested_requirements) ||
        JSON.stringify(claimIds(input.requested_requirements)) !==
          JSON.stringify(input.requested_claim_ids) ||
        input.subject_binding_intent === "none" ||
        input.protocol_version !== SELF_PASS_PROTOCOL_VERSION ||
        !mockPassportAllowed(input.environment, options.mock_passport) ||
        !validAppName(options.app_name) ||
        !validCallbackOrigin(options.callback_origin) ||
        !SELF_PASS_MANIFEST.environments.includes(
          input.environment as (typeof SELF_PASS_MANIFEST.environments)[number],
        )
      ) {
        return Effect.succeed({ status: "unsupported" as const });
      }
      return Effect.succeed({
        status: "supported" as const,
        request_mode: "dynamic" as const,
        provider_configuration: selfPassConfigurationFor(
          options.callback_origin,
          options.mock_passport,
        ),
      });
    },
    start: (input: VerificationProviderStartInput) => {
      if (
        input.request_mode !== "dynamic" ||
        !sameConfiguration(
          input.provider_configuration,
          selfPassConfigurationFor(options.callback_origin, options.mock_passport),
        ) ||
        !fixedScope(input) ||
        !requirementsSupported(input.requested_requirements) ||
        JSON.stringify(claimIds(input.requested_requirements)) !==
          JSON.stringify(input.requested_claim_ids) ||
        input.method !== "document" ||
        input.protocol_version !== SELF_PASS_PROTOCOL_VERSION ||
        input.subject_binding_intent === "none" ||
        !mockPassportAllowed(input.environment, options.mock_passport) ||
        !validAppName(options.app_name) ||
        !validCallbackOrigin(options.callback_origin) ||
        !SELF_PASS_MANIFEST.environments.includes(
          input.environment as (typeof SELF_PASS_MANIFEST.environments)[number],
        )
      ) {
        return Effect.fail(rejected("start"));
      }
      const session_id = options.identifiers.next("session");
      const user_id = selfUserIdForRequest(input.request_hash);
      const launch: SelfPassLaunch = {
        app_name: options.app_name,
        endpoint: callbackEndpoint(options.callback_origin),
        endpoint_type: endpointType(options.mock_passport),
        scope: SELF_PASS_RP_SCOPE,
        session_id,
        user_id,
        user_id_type: "uuid",
        disclosures: compileDisclosures(input.requested_requirements),
        dev_mode: options.mock_passport,
        user_defined_data: encodeUserDefinedData({
          proof_session_id: session_id,
          request_hash: input.request_hash,
        }),
        version: 2,
      };
      return Effect.succeed(makeSession(input, launch, options));
    },
    complete: (input: VerificationProviderCompleteInput) => {
      const verifierSettings = verifierSettingsFromConfiguration(
        input.session.provider_configuration,
      );
      if (
        input.session.provider_id !== SELF_PASS_PROVIDER_ID ||
        input.session.request_mode !== "dynamic" ||
        verifierSettings === undefined ||
        !fixedScope(input.session) ||
        input.session.method !== "document" ||
        input.session.protocol_version !== SELF_PASS_PROTOCOL_VERSION ||
        !requirementsSupported(input.session.requested_requirements) ||
        JSON.stringify(claimIds(input.session.requested_requirements)) !==
          JSON.stringify(input.session.requested_claim_ids) ||
        input.session.subject_binding_intent === "none" ||
        !mockPassportAllowed(input.session.environment, verifierSettings.mock_passport)
      ) {
        return Effect.fail(rejected("complete"));
      }
      if (
        input.submission.channel !== "client_result" &&
        input.submission.channel !== "provider_callback"
      ) {
        return Effect.fail(rejected("complete"));
      }
      return decodeSubmission(input.submission.payload).pipe(
        Effect.filterOrFail(
          (submission) =>
            submission.session_id === undefined || submission.session_id === input.session.id,
          () => rejected("complete"),
        ),
        Effect.flatMap((submission) => {
          const sdkEffect =
            options.sdk === undefined
              ? Effect.tryPromise({
                  try: () => loadSelfPassSdk(),
                  catch: () =>
                    new VerificationProviderMisconfigured({
                      provider_id: SELF_PASS_PROVIDER_ID,
                      operation: "complete",
                    }),
                })
              : Effect.succeed(options.sdk);
          return sdkEffect.pipe(
            Effect.flatMap((sdk) => {
              const config = compileVerificationConfig(input.session.requested_requirements);
              const verifier = new sdk.SelfBackendVerifier(
                SELF_PASS_RP_SCOPE,
                callbackEndpoint(verifierSettings.callback_origin),
                verifierSettings.mock_passport,
                sdk.AllIds,
                new sdk.DefaultConfigStore(config),
                "uuid",
              );
              return Effect.tryPromise({
                try: () =>
                  verifier.verify(
                    submission.attestation_id,
                    submission.proof,
                    submission.public_signals,
                    submission.user_context_data,
                  ),
                catch: () => rejected("complete"),
              }).pipe(
                Effect.flatMap((result) =>
                  decodeResult(result).pipe(
                    Effect.filterOrFail(
                      (decoded) => decoded.attestationId === submission.attestation_id,
                      () => rejected("complete"),
                    ),
                  ),
                ),
                Effect.flatMap((result) => {
                  const observed_at = options.clock.now();
                  return validateClaims(input.session, result, observed_at).pipe(
                    Effect.map((normalized) => ({ submission, result, normalized, observed_at })),
                  );
                }),
              );
            }),
          );
        }),
        Effect.flatMap(({ submission, result, normalized, observed_at }) =>
          evidenceBundle(input.session, submission, result, normalized, observed_at, options),
        ),
      );
    },
    resolveCallback: (input: VerificationProviderCallbackInput) => {
      const parsed = (() => {
        try {
          return JSON.parse(input.raw_body) as unknown;
        } catch {
          return undefined;
        }
      })();
      return decodeSubmission(parsed).pipe(
        Effect.mapError(() => rejected("callback")),
        Effect.filterOrFail(
          (submission) => Option.isSome(decodeCallbackContext(submission.user_context_data)),
          () => rejected("callback"),
        ),
        Effect.flatMap((submission) => {
          const context = decodeCallbackContext(submission.user_context_data);
          if (Option.isNone(context)) return Effect.fail(rejected("callback"));
          return options.digest.digest(input.raw_body).pipe(
            Effect.flatMap(decodeCallbackDigest),
            Effect.flatMap((idempotency_key) =>
              Effect.succeed({
                proof_session_id: context.value.proof_session_id,
                idempotency_key,
                submission: { channel: "provider_callback" as const, payload: parsed },
              } satisfies VerificationProviderCallbackResolution),
            ),
          );
        }),
      );
    },
  } satisfies VerificationProviderAdapter;
  return provider;
}
