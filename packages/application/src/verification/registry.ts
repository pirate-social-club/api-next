import {
  type Assertion,
  CANONICAL_CLAIM_CATALOG,
  type CanonicalClaimIdentifier,
  EvidenceBundle,
  ProofProviderManifest,
  type ProofSession,
  type SubjectKeyScopeSemantics,
  type SubjectScope,
  sameVerificationRequirements,
  type VerificationRequirement,
  verificationRequirementClaimIds,
} from "@pirate/domain/verification";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import {
  ProviderSessionStart,
  VERIFICATION_CALLBACK_CREDENTIAL_HEADERS,
  type VerificationProviderAdapter,
  VerificationProviderCallbackInput,
  VerificationProviderCallbackResolution,
  VerificationProviderCallbackResponseInput,
  VerificationProviderCompleteInput,
  type VerificationProviderFailure,
  VerificationProviderInvalidResponse,
  VerificationProviderMisconfigured,
  VerificationProviderPlanInput,
  VerificationProviderPlanResult,
  VerificationProviderRejected,
  VerificationProviderStartInput,
  VerificationProviderUnavailable,
  VerificationProviderUnboundRejected,
} from "./adapter.ts";
import { computeVerificationRequestHash } from "./request-hash.ts";

export type VerificationProviderManifestField =
  | "schema"
  | "provider_id"
  | "manifest_version"
  | "operation_deadlines"
  | "callback_mode"
  | "callback_header_allowlist"
  | "callback_seam"
  | "protocol_versions"
  | "environments"
  | "supported_methods"
  | "claim_ids"
  | "claim_capabilities"
  | "presentation_kinds"
  | "assurance_levels"
  | "subject_key_scope_semantics";

export class VerificationProviderManifestInvalid extends Data.TaggedError(
  "VerificationProviderManifestInvalid",
)<{
  readonly provider_id: string;
  readonly field: VerificationProviderManifestField;
}> {}

export class VerificationProviderDuplicate extends Data.TaggedError(
  "VerificationProviderDuplicate",
)<{
  readonly provider_id: string;
}> {}

export class VerificationProviderUnknown extends Data.TaggedError("VerificationProviderUnknown")<{
  readonly provider_id: string;
}> {}

export type VerificationProviderRegistryError =
  | VerificationProviderManifestInvalid
  | VerificationProviderDuplicate;

const canonicalClaimIds = new Set(CANONICAL_CLAIM_CATALOG.map((entry) => entry.id));
const canonicalClaimCatalog = new Map(CANONICAL_CLAIM_CATALOG.map((entry) => [entry.id, entry]));
const ProviderIdHint = Schema.Struct({ provider_id: Schema.NonEmptyString });

function providerIdOf(value: unknown): string {
  return Option.getOrElse(Schema.decodeUnknownOption(ProviderIdHint)(value), () => ({
    provider_id: "unknown",
  })).provider_id;
}

function invalid(
  provider_id: string,
  field: VerificationProviderManifestField,
): VerificationProviderManifestInvalid {
  return new VerificationProviderManifestInvalid({ provider_id, field });
}

function uniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function nonBlankStrings(values: readonly string[]): boolean {
  return values.every((value) => value.length > 0 && value.trim() === value);
}

const callbackHeaderName = /^[a-z0-9!#$%&'*+.^_`|~-]+$/u;

type CallbackCredentialHeaderOptions = Readonly<{
  readonly callbackCredentialHeaders?: readonly string[] | ReadonlySet<string>;
}>;

function credentialHeaderSet(
  extra: readonly string[] | ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  const headers = new Set(VERIFICATION_CALLBACK_CREDENTIAL_HEADERS);
  for (const name of extra ?? []) headers.add(name.toLowerCase());
  return headers;
}

function callbackManifestValid(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  credentials: ReadonlySet<string> = VERIFICATION_CALLBACK_CREDENTIAL_HEADERS,
): VerificationProviderManifestField | undefined {
  if (
    !uniqueStrings(manifest.callback_header_allowlist) ||
    !manifest.callback_header_allowlist.every(
      (name) =>
        name.length <= 128 &&
        name === name.toLowerCase() &&
        callbackHeaderName.test(name) &&
        !credentials.has(name),
    )
  ) {
    return "callback_header_allowlist";
  }
  if (manifest.callback_mode === "none" && manifest.callback_header_allowlist.length !== 0) {
    return "callback_mode";
  }
  return undefined;
}

/** Decode and validate provider metadata before it enters the registry. */
export function validateProofProviderManifest(
  input: unknown,
  options: CallbackCredentialHeaderOptions = {},
): Effect.Effect<
  Schema.Schema.Type<typeof ProofProviderManifest>,
  VerificationProviderManifestInvalid
> {
  const provider_id = providerIdOf(input);
  return Effect.try({
    try: () => Schema.decodeUnknownSync(ProofProviderManifest)(input),
    catch: () => invalid(provider_id, "schema"),
  }).pipe(
    Effect.flatMap((manifest) => {
      const callbackError = callbackManifestValid(
        manifest,
        credentialHeaderSet(options.callbackCredentialHeaders),
      );
      if (callbackError !== undefined) {
        return Effect.fail(invalid(provider_id, callbackError));
      }
      if (manifest.provider_id.trim() !== manifest.provider_id) {
        return Effect.fail(invalid(provider_id, "provider_id"));
      }
      if (manifest.manifest_version.trim() !== manifest.manifest_version) {
        return Effect.fail(invalid(provider_id, "manifest_version"));
      }
      if (
        manifest.protocol_versions.length === 0 ||
        !uniqueStrings(manifest.protocol_versions) ||
        !nonBlankStrings(manifest.protocol_versions)
      ) {
        return Effect.fail(invalid(provider_id, "protocol_versions"));
      }
      if (
        manifest.environments.length === 0 ||
        !uniqueStrings(manifest.environments) ||
        !nonBlankStrings(manifest.environments)
      ) {
        return Effect.fail(invalid(provider_id, "environments"));
      }
      if (
        manifest.supported_methods.length === 0 ||
        !uniqueStrings(manifest.supported_methods) ||
        !nonBlankStrings(manifest.supported_methods)
      ) {
        return Effect.fail(invalid(provider_id, "supported_methods"));
      }
      if (
        manifest.claim_ids.length === 0 ||
        !uniqueStrings(manifest.claim_ids) ||
        manifest.claim_ids.some((claim) => !canonicalClaimIds.has(claim))
      ) {
        return Effect.fail(invalid(provider_id, "claim_ids"));
      }
      if (
        manifest.claim_capabilities.length === 0 ||
        !uniqueStrings(manifest.claim_capabilities.map((capability) => capability.claim_id)) ||
        manifest.claim_capabilities.some(
          (capability) =>
            capability.request_modes.length === 0 || !uniqueStrings(capability.request_modes),
        ) ||
        !sameClaimSet(
          manifest.claim_capabilities.map((capability) => capability.claim_id),
          manifest.claim_ids,
        )
      ) {
        return Effect.fail(invalid(provider_id, "claim_capabilities"));
      }
      if (manifest.presentation_kinds.length === 0 || !uniqueStrings(manifest.presentation_kinds)) {
        return Effect.fail(invalid(provider_id, "presentation_kinds"));
      }
      if (manifest.assurance_levels.length === 0 || !uniqueStrings(manifest.assurance_levels)) {
        return Effect.fail(invalid(provider_id, "assurance_levels"));
      }
      const requiresNamedScope = manifest.claim_ids.some(
        (claim) => canonicalClaimCatalog.get(claim)?.scope_requirement === "named_issuer_scope",
      );
      if (requiresNamedScope && manifest.subject_key_scope_semantics === "none") {
        return Effect.fail(invalid(provider_id, "subject_key_scope_semantics"));
      }
      if (
        manifest.claim_ids.some(
          (claim) =>
            !manifest.assurance_levels.some((assurance) =>
              assuranceSupportsClaim(claim, assurance),
            ),
        )
      ) {
        return Effect.fail(invalid(provider_id, "assurance_levels"));
      }
      return Effect.succeed(manifest);
    }),
  );
}

function scopeSemantics(scope: SubjectScope): SubjectKeyScopeSemantics {
  return scope.kind === "named" ? scope.scope_semantics : "none";
}

function sameScope(left: SubjectScope, right: SubjectScope): boolean {
  if (
    left.kind !== right.kind ||
    left.issuer !== right.issuer ||
    scopeSemantics(left) !== scopeSemantics(right)
  ) {
    return false;
  }
  if (left.kind === "none" && right.kind === "none") {
    return true;
  }
  if (left.kind === "named" && right.kind === "named") {
    if (left.rp_scope !== right.rp_scope) return false;
    if (
      left.scope_semantics === "issuer_rp_action_scope" &&
      right.scope_semantics === "issuer_rp_action_scope"
    ) {
      return left.action_scope === right.action_scope;
    }
    return (
      left.scope_semantics === "issuer_rp_scope" && right.scope_semantics === "issuer_rp_scope"
    );
  }
  return false;
}

function sameClaimSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    uniqueStrings(left) &&
    uniqueStrings(right) &&
    left.length === right.length &&
    left.every((claim) => right.includes(claim))
  );
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function requirementsMatchClaims(
  requirements: readonly VerificationRequirement[],
  claims: readonly CanonicalClaimIdentifier[],
): boolean {
  const projected = verificationRequirementClaimIds(requirements);
  return (
    projected.length === claims.length && projected.every((claim, index) => claim === claims[index])
  );
}

function requiresNamedScope(claims: readonly string[]): boolean {
  return claims.some(
    (claim) =>
      canonicalClaimCatalog.get(claim as CanonicalClaimIdentifier)?.scope_requirement ===
      "named_issuer_scope",
  );
}

function requestModeSupported(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  claims: readonly CanonicalClaimIdentifier[],
  requestMode: "curated" | "dynamic",
): boolean {
  return claims.every((claim) =>
    manifest.claim_capabilities
      .find((capability) => capability.claim_id === claim)
      ?.request_modes.includes(requestMode),
  );
}

function configurationMatchesRequestMode(
  configuration: { readonly kind: "managed" | "dynamic" },
  requestMode: "curated" | "dynamic",
): boolean {
  return (
    (requestMode === "curated" && configuration.kind === "managed") ||
    (requestMode === "dynamic" && configuration.kind === "dynamic")
  );
}

function bindingIntentMatchesManifest(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  intent: "establish" | "recover" | "none",
): boolean {
  return manifest.subject_key_scope_semantics === "none" ? intent === "none" : intent !== "none";
}

function assuranceSupportsClaim(claim: CanonicalClaimIdentifier, assurance: string): boolean {
  const entry = canonicalClaimCatalog.get(claim);
  return entry?.holder_liveness !== "required" || assurance === "holder_live";
}

function assertionMatchesRequirement(
  assertion: Assertion,
  requirements: readonly VerificationRequirement[],
): boolean {
  const requirement = requirements.find((candidate) => candidate.claim_id === assertion.claim_id);
  if (requirement === undefined) return false;
  switch (assertion.claim_id) {
    case "age.minimum":
      return (
        requirement.claim_id === "age.minimum" &&
        assertion.value.minimum_age === requirement.minimum_age
      );
    case "nationality.allowed":
      return (
        requirement.claim_id === "nationality.allowed" &&
        (assertion.value.disclosed_nationality === undefined ||
          requirement.allowed_countries.includes(assertion.value.disclosed_nationality))
      );
    case "gender.marker":
      return (
        requirement.claim_id === "gender.marker" &&
        requirement.allowed_markers.includes(assertion.value.gender)
      );
    case "asset.ownership":
      return (
        requirement.claim_id === "asset.ownership" &&
        JSON.stringify(assertion.value.descriptor) === JSON.stringify(requirement.descriptor) &&
        BigInt(assertion.value.quantity) >= BigInt(requirement.minimum_quantity)
      );
    case "disclosed.predicate":
      return (
        requirement.claim_id === "disclosed.predicate" &&
        assertion.value.predicate === requirement.predicate &&
        JSON.stringify(assertion.value.value) === JSON.stringify(requirement.expected_value)
      );
    default:
      return requirement.claim_id === assertion.claim_id;
  }
}

type SessionCompatibilityMember =
  | "status"
  | "expires_at"
  | "provider_id"
  | "method"
  | "protocol_version"
  | "environment"
  | "requested_claim_ids"
  | "request_mode"
  | "provider_configuration"
  | "requested_requirements"
  | "claim_ids"
  | "subject_binding_intent"
  | "scope"
  | "named_scope";

function firstSessionCompatibilityFailure(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  session: ProofSession,
  now: number,
): SessionCompatibilityMember | undefined {
  const expiresAt = Date.parse(session.expires_at);
  if (session.status !== "pending") return "status";
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return "expires_at";
  if (session.provider_id !== manifest.provider_id) return "provider_id";
  if (!manifest.supported_methods.includes(session.method)) return "method";
  if (!manifest.protocol_versions.includes(session.protocol_version)) {
    return "protocol_version";
  }
  if (!manifest.environments.includes(session.environment)) return "environment";
  if (session.requested_claim_ids.length === 0 || !uniqueStrings(session.requested_claim_ids)) {
    return "requested_claim_ids";
  }
  if (!requestModeSupported(manifest, session.requested_claim_ids, session.request_mode)) {
    return "request_mode";
  }
  if (!configurationMatchesRequestMode(session.provider_configuration, session.request_mode)) {
    return "provider_configuration";
  }
  if (!requirementsMatchClaims(session.requested_requirements, session.requested_claim_ids)) {
    return "requested_requirements";
  }
  if (!session.requested_claim_ids.every((claim) => manifest.claim_ids.includes(claim))) {
    return "claim_ids";
  }
  if (!bindingIntentMatchesManifest(manifest, session.subject_binding_intent)) {
    return "subject_binding_intent";
  }
  if (scopeSemantics(session.scope) !== manifest.subject_key_scope_semantics) return "scope";
  if (requiresNamedScope(session.requested_claim_ids) && scopeSemantics(session.scope) === "none") {
    return "named_scope";
  }
  return undefined;
}

function compatibleSession(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  session: ProofSession,
  now: number,
): boolean {
  const failure = firstSessionCompatibilityFailure(manifest, session, now);
  if (failure !== undefined) {
    console.warn("verification session rejected before provider completion", {
      failure_kind: "session_compatibility",
      compatibility_member: failure,
    });
    return false;
  }
  return true;
}

function safeAdapterFailure(
  provider_id: string,
  operation: "plan" | "start" | "complete" | "callback",
  error: unknown,
): VerificationProviderFailure {
  if (error instanceof VerificationProviderUnavailable) {
    return new VerificationProviderUnavailable({ provider_id, operation });
  }
  if (error instanceof VerificationProviderRejected) {
    return new VerificationProviderRejected({ provider_id, operation });
  }
  if (error instanceof VerificationProviderUnboundRejected && operation === "complete") {
    return new VerificationProviderUnboundRejected({ provider_id, operation });
  }
  if (error instanceof VerificationProviderInvalidResponse) {
    return new VerificationProviderInvalidResponse({ provider_id, operation });
  }
  if (error instanceof VerificationProviderMisconfigured) {
    return new VerificationProviderMisconfigured({ provider_id, operation });
  }
  return new VerificationProviderInvalidResponse({ provider_id, operation });
}

function unavailable(
  provider_id: string,
  operation: "plan" | "start" | "complete" | "callback",
): VerificationProviderUnavailable {
  return new VerificationProviderUnavailable({ provider_id, operation });
}

function sanitizeCallbackHeaders(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  headers: Readonly<Record<string, string>>,
  credentials: ReadonlySet<string>,
): Readonly<Record<string, string>> {
  const allowed = new Set(manifest.callback_header_allowlist);
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => allowed.has(name) && !credentials.has(name)),
  );
}

function callbackSeamValid(
  adapter: VerificationProviderAdapter,
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
): boolean {
  const hasVerify = adapter.verifyCallback !== undefined;
  const hasResolve = adapter.resolveCallback !== undefined;
  return (
    (manifest.callback_mode === "none" && !hasVerify && !hasResolve) ||
    (manifest.callback_mode === "signed_envelope" && hasVerify && !hasResolve) ||
    (manifest.callback_mode === "session_bound_proof" && !hasVerify && hasResolve)
  );
}

function normalizeCallbackInput(input: unknown): unknown {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return input;
  const record = input as Readonly<Record<string, unknown>>;
  const rawHeaders = record.headers;
  if (typeof rawHeaders !== "object" || rawHeaders === null || Array.isArray(rawHeaders)) {
    return input;
  }
  const headers: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    const normalized = name.toLowerCase();
    if (Object.hasOwn(headers, normalized)) return undefined;
    headers[normalized] = value;
  }
  return { ...record, headers };
}

function guardCallback(
  implementation: NonNullable<VerificationProviderAdapter["verifyCallback"]>,
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  credentials: ReadonlySet<string>,
): NonNullable<VerificationProviderAdapter["verifyCallback"]> {
  return (untrustedInput) => {
    const decodedInput = Schema.decodeUnknownOption(VerificationProviderCallbackInput)(
      normalizeCallbackInput(untrustedInput),
    );
    if (Option.isNone(decodedInput)) {
      return Effect.fail(
        new VerificationProviderRejected({
          provider_id: manifest.provider_id,
          operation: "callback",
        }),
      );
    }
    const sanitized = {
      ...decodedInput.value,
      headers: sanitizeCallbackHeaders(manifest, decodedInput.value.headers, credentials),
    };
    return Effect.suspend(() => implementation(sanitized)).pipe(
      Effect.timeout(manifest.operation_deadlines.callback_ms),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(unavailable(manifest.provider_id, "callback")),
      ),
      Effect.mapError((error) => safeAdapterFailure(manifest.provider_id, "callback", error)),
      Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "callback"))),
      Effect.flatMap((result) =>
        Effect.try({
          try: () => Schema.decodeUnknownSync(VerificationProviderCallbackResolution)(result),
          catch: () => invalidResponse(manifest.provider_id, "callback"),
        }),
      ),
      Effect.filterOrFail(
        (result) =>
          result.proof_session_id.trim() === result.proof_session_id &&
          result.idempotency_key.trim() === result.idempotency_key,
        () => invalidResponse(manifest.provider_id, "callback"),
      ),
    );
  };
}

function guardCallbackResponse(
  implementation: NonNullable<VerificationProviderAdapter["callbackResponse"]>,
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
): NonNullable<VerificationProviderAdapter["callbackResponse"]> {
  return (untrustedInput) => {
    const decodedInput = Schema.decodeUnknownOption(VerificationProviderCallbackResponseInput)(
      untrustedInput,
    );
    if (Option.isNone(decodedInput)) {
      return Effect.fail(invalidResponse(manifest.provider_id, "callback"));
    }
    return Effect.suspend(() => implementation(decodedInput.value)).pipe(
      Effect.timeout(manifest.operation_deadlines.callback_ms),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(unavailable(manifest.provider_id, "callback")),
      ),
      Effect.mapError((error) => safeAdapterFailure(manifest.provider_id, "callback", error)),
      Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "callback"))),
      Effect.flatMap((result) =>
        Effect.try({
          try: () => Schema.decodeUnknownSync(Schema.Json)(result),
          catch: () => invalidResponse(manifest.provider_id, "callback"),
        }),
      ),
    );
  };
}

function invalidResponse(
  provider_id: string,
  operation: "plan" | "start" | "complete" | "callback",
): VerificationProviderInvalidResponse {
  return new VerificationProviderInvalidResponse({ provider_id, operation });
}

function requestSupportedByManifest(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  input: Schema.Schema.Type<typeof VerificationProviderPlanInput> & {
    readonly request_mode?: "curated" | "dynamic";
    readonly provider_configuration?: {
      readonly kind: "managed" | "dynamic";
      readonly reference: string;
      readonly version: string;
    };
  },
): boolean {
  const requestedClaimsDeclared = input.requested_claim_ids.every((claim) =>
    manifest.claim_ids.includes(claim),
  );
  return (
    input.requested_claim_ids.length > 0 &&
    uniqueStrings(input.requested_claim_ids) &&
    requirementsMatchClaims(input.requested_requirements, input.requested_claim_ids) &&
    requestedClaimsDeclared &&
    (input.request_mode === undefined ||
      (input.provider_configuration !== undefined &&
        requestModeSupported(manifest, input.requested_claim_ids, input.request_mode) &&
        configurationMatchesRequestMode(input.provider_configuration, input.request_mode))) &&
    manifest.protocol_versions.includes(input.protocol_version) &&
    manifest.environments.includes(input.environment) &&
    manifest.supported_methods.includes(input.method) &&
    bindingIntentMatchesManifest(manifest, input.subject_binding_intent) &&
    scopeSemantics(input.scope) === manifest.subject_key_scope_semantics &&
    (!requiresNamedScope(input.requested_claim_ids) || scopeSemantics(input.scope) !== "none")
  );
}

function validateStartOutput(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  input: VerificationProviderStartInput,
  output: unknown,
  now: number,
): Effect.Effect<ProviderSessionStart, VerificationProviderInvalidResponse> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(ProviderSessionStart)(output),
    catch: () => invalidResponse(manifest.provider_id, "start"),
  }).pipe(
    Effect.flatMap((result) => {
      const session = result.session;
      const presentation = result.presentation;
      const expiresAt = Date.parse(session.expires_at);
      const expectedPresentation = manifest.presentation_kinds.includes(presentation.kind);
      if (
        session.status !== "pending" ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now ||
        session.provider_id !== manifest.provider_id ||
        session.actor_id !== input.actor_id ||
        session.intent_id !== input.intent_id ||
        session.request_hash !== input.request_hash ||
        session.method !== input.method ||
        !sameScope(session.scope, input.scope) ||
        session.request_mode !== input.request_mode ||
        session.provider_configuration.kind !== input.provider_configuration.kind ||
        session.provider_configuration.reference !== input.provider_configuration.reference ||
        session.provider_configuration.version !== input.provider_configuration.version ||
        !sameVerificationRequirements(
          session.requested_requirements,
          input.requested_requirements,
        ) ||
        !sameOrderedStrings(session.requested_claim_ids, input.requested_claim_ids) ||
        session.subject_binding_intent !== input.subject_binding_intent ||
        session.protocol_version !== input.protocol_version ||
        session.environment !== input.environment ||
        scopeSemantics(session.scope) !== manifest.subject_key_scope_semantics ||
        presentation.session_id !== session.id ||
        !expectedPresentation
      ) {
        return Effect.fail(invalidResponse(manifest.provider_id, "start"));
      }
      return Effect.succeed(result);
    }),
  );
}

function validateBundle(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  input: VerificationProviderCompleteInput,
  output: unknown,
): Effect.Effect<EvidenceBundle, VerificationProviderInvalidResponse> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(EvidenceBundle)(output),
    catch: () => invalidResponse(manifest.provider_id, "complete"),
  }).pipe(
    Effect.flatMap((bundle) => {
      const receiptIds = new Set(bundle.receipts.map((receipt) => receipt.id));
      const receiptsById = new Map(bundle.receipts.map((receipt) => [receipt.id, receipt]));
      const subjectIds = new Set(bundle.subject_keys.map((subjectKey) => subjectKey.id));
      const bindingsById = new Map(bundle.binding_groups.map((group) => [group.id, group]));
      const requested = new Set(input.session.requested_claim_ids);
      const declaredAssurances = new Set(manifest.assurance_levels);
      const subjectReferencesRequired =
        manifest.subject_key_scope_semantics !== "none" || requiresNamedScope([...requested]);
      const subjectKeysValid = bundle.subject_keys.every(
        (subjectKey) =>
          subjectKey.issuer === input.session.scope.issuer &&
          subjectKey.method === input.session.method &&
          sameScope(subjectKey.scope, input.session.scope),
      );

      const receiptsValid =
        uniqueStrings(bundle.receipts.map((receipt) => receipt.id)) &&
        uniqueStrings(bundle.subject_keys.map((subjectKey) => subjectKey.id)) &&
        uniqueStrings(bundle.binding_groups.map((group) => group.id)) &&
        uniqueStrings(bundle.assertions.map((assertion) => assertion.id)) &&
        bundle.receipts.every(
          (receipt) =>
            receipt.proof_session_id === input.session.id &&
            receipt.provider_id === manifest.provider_id &&
            receipt.issuer === input.session.scope.issuer &&
            receipt.method === input.session.method &&
            receipt.provider_configuration.kind === input.session.provider_configuration.kind &&
            receipt.provider_configuration.reference ===
              input.session.provider_configuration.reference &&
            receipt.provider_configuration.version ===
              input.session.provider_configuration.version &&
            receipt.protocol_version === input.session.protocol_version &&
            receipt.environment === input.session.environment &&
            sameScope(receipt.scope, input.session.scope),
        );
      const receiptSubjectsValid = bundle.receipts.every(
        (receipt) => receipt.subject_key_id === undefined || subjectIds.has(receipt.subject_key_id),
      );
      const subjectReferencesRequiredValid =
        !subjectReferencesRequired ||
        (bundle.subject_keys.length > 0 &&
          bundle.receipts.every((receipt) => receipt.subject_key_id !== undefined) &&
          bundle.assertions.every((assertion) => assertion.subject_key_id !== undefined));
      const bindingsValid = bundle.binding_groups.every((group) =>
        group.kind === "same_subject"
          ? subjectIds.has(group.subject_key_id)
          : receiptIds.has(group.evidence_receipt_id),
      );
      const assertionsValid = bundle.assertions.every((assertion) => {
        const receipt = receiptsById.get(assertion.evidence_receipt_id);
        const binding = bindingsById.get(assertion.binding_group_id);
        const subjectMatchesReceipt =
          receipt !== undefined && receipt.subject_key_id === assertion.subject_key_id;
        const bindingMatchesAssertion =
          binding?.kind === "same_subject"
            ? binding.subject_key_id === assertion.subject_key_id
            : binding?.kind === "same_receipt"
              ? binding.evidence_receipt_id === assertion.evidence_receipt_id
              : false;
        return (
          requested.has(assertion.claim_id) &&
          assertionMatchesRequirement(assertion, input.session.requested_requirements) &&
          declaredAssurances.has(assertion.assurance) &&
          assuranceSupportsClaim(assertion.claim_id, assertion.assurance) &&
          (assertion.subject_key_id === undefined || subjectIds.has(assertion.subject_key_id)) &&
          subjectMatchesReceipt &&
          bindingMatchesAssertion
        );
      });
      const requestedClaimsPresent = [...requested].every((claim) =>
        bundle.assertions.some((assertion) => assertion.claim_id === claim),
      );
      if (
        bundle.proof_session_id !== input.session.id ||
        !receiptsValid ||
        !subjectKeysValid ||
        !receiptSubjectsValid ||
        !subjectReferencesRequiredValid ||
        !bindingsValid ||
        !assertionsValid ||
        !requestedClaimsPresent
      ) {
        return Effect.fail(invalidResponse(manifest.provider_id, "complete"));
      }
      return Effect.succeed(bundle);
    }),
  );
}

function guardAdapter(
  adapter: VerificationProviderAdapter,
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  now: () => number,
  credentials: ReadonlySet<string>,
): VerificationProviderAdapter {
  const guarded: VerificationProviderAdapter = {
    manifest,
    plan: (untrustedInput) => {
      const decodedInput = Schema.decodeUnknownOption(VerificationProviderPlanInput)(
        untrustedInput,
      );
      if (
        Option.isNone(decodedInput) ||
        !requestSupportedByManifest(manifest, decodedInput.value)
      ) {
        return Effect.fail(
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "plan",
          }),
        );
      }
      return Effect.suspend(() => adapter.plan(decodedInput.value)).pipe(
        Effect.timeout(manifest.operation_deadlines.plan_ms),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(unavailable(manifest.provider_id, "plan")),
        ),
        Effect.mapError((error) => safeAdapterFailure(manifest.provider_id, "plan", error)),
        Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "plan"))),
        Effect.flatMap((result) =>
          Effect.try({
            try: () => Schema.decodeUnknownSync(VerificationProviderPlanResult)(result),
            catch: () => invalidResponse(manifest.provider_id, "plan"),
          }),
        ),
        Effect.flatMap((result) =>
          result.status !== "supported" ||
          (requestModeSupported(
            manifest,
            decodedInput.value.requested_claim_ids,
            result.request_mode,
          ) &&
            configurationMatchesRequestMode(result.provider_configuration, result.request_mode))
            ? Effect.succeed(result)
            : Effect.fail(invalidResponse(manifest.provider_id, "plan")),
        ),
      );
    },
    start: (untrustedInput) => {
      const decodedInput = Schema.decodeUnknownOption(VerificationProviderStartInput)(
        untrustedInput,
      );
      if (Option.isNone(decodedInput)) {
        return Effect.fail(
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
        );
      }
      const input = decodedInput.value;
      if (!requestSupportedByManifest(manifest, input)) {
        return Effect.fail(
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
        );
      }
      return Effect.tryPromise({
        try: () => computeVerificationRequestHash(manifest.provider_id, input),
        catch: () =>
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
      }).pipe(
        Effect.filterOrFail(
          (expectedHash) => expectedHash === input.request_hash,
          () =>
            new VerificationProviderRejected({
              provider_id: manifest.provider_id,
              operation: "start",
            }),
        ),
        Effect.flatMap(() =>
          Effect.suspend(() => adapter.start(input)).pipe(
            Effect.timeout(manifest.operation_deadlines.start_ms),
            Effect.catchTag("TimeoutError", () =>
              Effect.fail(unavailable(manifest.provider_id, "start")),
            ),
          ),
        ),
        Effect.mapError((error) => safeAdapterFailure(manifest.provider_id, "start", error)),
        Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "start"))),
        Effect.flatMap((result) => validateStartOutput(manifest, input, result, now())),
      );
    },
    complete: (untrustedInput) => {
      const decodedInput = Schema.decodeUnknownOption(VerificationProviderCompleteInput)(
        untrustedInput,
      );
      if (
        Option.isNone(decodedInput) ||
        !compatibleSession(manifest, decodedInput.value.session, now())
      ) {
        return Effect.fail(
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "complete",
          }),
        );
      }
      const input = decodedInput.value;
      return Effect.suspend(() => adapter.complete(input)).pipe(
        Effect.timeout(manifest.operation_deadlines.complete_ms),
        Effect.catchTag("TimeoutError", () =>
          Effect.fail(unavailable(manifest.provider_id, "complete")),
        ),
        Effect.mapError((error) => safeAdapterFailure(manifest.provider_id, "complete", error)),
        Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "complete"))),
        Effect.flatMap((result) => validateBundle(manifest, input, result)),
      );
    },
  };
  return {
    ...guarded,
    ...(adapter.verifyCallback === undefined
      ? {}
      : { verifyCallback: guardCallback(adapter.verifyCallback, manifest, credentials) }),
    ...(adapter.resolveCallback === undefined
      ? {}
      : { resolveCallback: guardCallback(adapter.resolveCallback, manifest, credentials) }),
    ...(adapter.callbackResponse === undefined
      ? {}
      : { callbackResponse: guardCallbackResponse(adapter.callbackResponse, manifest) }),
  };
}

export interface VerificationProviderRegistryService {
  readonly list: () => readonly Schema.Schema.Type<typeof ProofProviderManifest>[];
  readonly resolve: (
    provider_id: string,
  ) => Effect.Effect<VerificationProviderAdapter, VerificationProviderUnknown>;
}

export class VerificationProviderRegistry extends Context.Service<
  VerificationProviderRegistry,
  VerificationProviderRegistryService
>()("@pirate/application/verification/VerificationProviderRegistry") {}

export interface VerificationProviderRegistryOptions {
  /** Injectable for deterministic expiry tests and request-scoped clocks. */
  readonly now?: () => number;
  /** Additional deployment-specific credential headers are always stripped. */
  readonly callbackCredentialHeaders?: readonly string[] | ReadonlySet<string>;
}

export function makeVerificationProviderRegistry(
  adapters: readonly VerificationProviderAdapter[],
  options: VerificationProviderRegistryOptions = {},
): Effect.Effect<VerificationProviderRegistryService, VerificationProviderRegistryError> {
  return Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const credentials = credentialHeaderSet(options.callbackCredentialHeaders);
    const registered = new Map<string, VerificationProviderAdapter>();
    for (const adapter of adapters) {
      const manifest = yield* validateProofProviderManifest(adapter.manifest, {
        callbackCredentialHeaders: credentials,
      });
      if (!callbackSeamValid(adapter, manifest)) {
        return yield* Effect.fail(invalid(manifest.provider_id, "callback_seam"));
      }
      if (registered.has(manifest.provider_id)) {
        return yield* Effect.fail(
          new VerificationProviderDuplicate({ provider_id: manifest.provider_id }),
        );
      }
      registered.set(manifest.provider_id, guardAdapter(adapter, manifest, now, credentials));
    }
    return {
      list: () => [...registered.values()].map((adapter) => adapter.manifest),
      resolve: (provider_id: string) => {
        const adapter = registered.get(provider_id);
        return adapter === undefined
          ? Effect.fail(new VerificationProviderUnknown({ provider_id }))
          : Effect.succeed(adapter);
      },
    } satisfies VerificationProviderRegistryService;
  });
}

export function makeVerificationProviderRegistryLayer(
  adapters: readonly VerificationProviderAdapter[],
  options: VerificationProviderRegistryOptions = {},
): Layer.Layer<VerificationProviderRegistry, VerificationProviderRegistryError> {
  return Layer.effect(
    VerificationProviderRegistry,
    makeVerificationProviderRegistry(adapters, options),
  );
}
