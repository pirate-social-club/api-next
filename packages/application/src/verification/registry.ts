import {
  CANONICAL_CLAIM_CATALOG,
  type CanonicalClaimIdentifier,
  EvidenceBundle,
  ProofProviderManifest,
  type ProofSession,
  type SubjectKeyScopeSemantics,
  type SubjectScope,
} from "@pirate/domain/verification";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import {
  ProviderSessionStart,
  type VerificationProviderAdapter,
  type VerificationProviderFailure,
  VerificationProviderInvalidResponse,
  VerificationProviderMisconfigured,
  VerificationProviderRejected,
  type VerificationProviderStartInput,
  VerificationProviderUnavailable,
  type VerificationProviderVerifyInput,
} from "./adapter.ts";

export type VerificationProviderManifestField =
  | "schema"
  | "provider_id"
  | "manifest_version"
  | "protocol_versions"
  | "environments"
  | "supported_methods"
  | "claim_ids"
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

/** Decode and validate provider metadata before it enters the registry. */
export function validateProofProviderManifest(
  input: unknown,
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

function requiresNamedScope(claims: readonly string[]): boolean {
  return claims.some(
    (claim) =>
      canonicalClaimCatalog.get(claim as CanonicalClaimIdentifier)?.scope_requirement ===
      "named_issuer_scope",
  );
}

function assuranceSupportsClaim(claim: CanonicalClaimIdentifier, assurance: string): boolean {
  const entry = canonicalClaimCatalog.get(claim);
  return entry?.holder_liveness !== "required" || assurance === "holder_live";
}

function compatibleSession(
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  session: ProofSession,
  now: number,
): boolean {
  const expiresAt = Date.parse(session.expires_at);
  return (
    session.status === "pending" &&
    Number.isFinite(expiresAt) &&
    expiresAt > now &&
    session.provider_id === manifest.provider_id &&
    manifest.supported_methods.includes(session.method) &&
    manifest.protocol_versions.includes(session.protocol_version) &&
    manifest.environments.includes(session.environment) &&
    session.requested_claim_ids.length > 0 &&
    uniqueStrings(session.requested_claim_ids) &&
    session.requested_claim_ids.every((claim) => manifest.claim_ids.includes(claim)) &&
    scopeSemantics(session.scope) === manifest.subject_key_scope_semantics &&
    (!requiresNamedScope(session.requested_claim_ids) || scopeSemantics(session.scope) !== "none")
  );
}

function safeAdapterFailure(
  provider_id: string,
  operation: "start" | "verify",
  error: unknown,
): VerificationProviderFailure {
  if (error instanceof VerificationProviderUnavailable) {
    return new VerificationProviderUnavailable({ provider_id, operation });
  }
  if (error instanceof VerificationProviderRejected) {
    return new VerificationProviderRejected({ provider_id, operation });
  }
  if (error instanceof VerificationProviderInvalidResponse) {
    return new VerificationProviderInvalidResponse({ provider_id, operation });
  }
  if (error instanceof VerificationProviderMisconfigured) {
    return new VerificationProviderMisconfigured({ provider_id, operation });
  }
  return new VerificationProviderInvalidResponse({ provider_id, operation });
}

function invalidResponse(
  provider_id: string,
  operation: "start" | "verify",
): VerificationProviderInvalidResponse {
  return new VerificationProviderInvalidResponse({ provider_id, operation });
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
        !sameClaimSet(session.requested_claim_ids, input.requested_claim_ids) ||
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
  input: VerificationProviderVerifyInput,
  output: unknown,
): Effect.Effect<EvidenceBundle, VerificationProviderInvalidResponse> {
  return Effect.try({
    try: () => Schema.decodeUnknownSync(EvidenceBundle)(output),
    catch: () => invalidResponse(manifest.provider_id, "verify"),
  }).pipe(
    Effect.flatMap((bundle) => {
      const receiptIds = new Set(bundle.receipts.map((receipt) => receipt.id));
      const receiptsById = new Map(bundle.receipts.map((receipt) => [receipt.id, receipt]));
      const subjectIds = new Set(bundle.subject_keys.map((subjectKey) => subjectKey.id));
      const bindingIds = new Set(bundle.binding_groups.map((group) => group.id));
      const bindingsById = new Map(bundle.binding_groups.map((group) => [group.id, group]));
      const requested = new Set(input.session.requested_claim_ids);
      const declared = new Set(manifest.claim_ids);
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
          declared.has(assertion.claim_id) &&
          declaredAssurances.has(assertion.assurance) &&
          assuranceSupportsClaim(assertion.claim_id, assertion.assurance) &&
          receiptIds.has(assertion.evidence_receipt_id) &&
          (assertion.subject_key_id === undefined || subjectIds.has(assertion.subject_key_id)) &&
          bindingIds.has(assertion.binding_group_id) &&
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
        return Effect.fail(invalidResponse(manifest.provider_id, "verify"));
      }
      return Effect.succeed(bundle);
    }),
  );
}

function guardAdapter(
  adapter: VerificationProviderAdapter,
  manifest: Schema.Schema.Type<typeof ProofProviderManifest>,
  now: () => number,
): VerificationProviderAdapter {
  return {
    manifest,
    start: (input) => {
      const requestedClaimsDeclared = input.requested_claim_ids.every((claim) =>
        manifest.claim_ids.includes(claim),
      );
      if (
        input.requested_claim_ids.length === 0 ||
        !uniqueStrings(input.requested_claim_ids) ||
        !requestedClaimsDeclared ||
        !manifest.protocol_versions.includes(input.protocol_version) ||
        !manifest.environments.includes(input.environment) ||
        !manifest.supported_methods.includes(input.method) ||
        scopeSemantics(input.scope) !== manifest.subject_key_scope_semantics ||
        (requiresNamedScope(input.requested_claim_ids) && scopeSemantics(input.scope) === "none")
      ) {
        return Effect.fail(
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "start",
          }),
        );
      }
      return Effect.suspend(() => adapter.start(input)).pipe(
        Effect.mapError((error) => safeAdapterFailure(manifest.provider_id, "start", error)),
        Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "start"))),
        Effect.flatMap((result) => validateStartOutput(manifest, input, result, now())),
      );
    },
    verify: (input) => {
      if (!compatibleSession(manifest, input.session, now())) {
        return Effect.fail(
          new VerificationProviderRejected({
            provider_id: manifest.provider_id,
            operation: "verify",
          }),
        );
      }
      return Effect.suspend(() => adapter.verify(input)).pipe(
        Effect.mapError((error) => safeAdapterFailure(manifest.provider_id, "verify", error)),
        Effect.catchDefect(() => Effect.fail(invalidResponse(manifest.provider_id, "verify"))),
        Effect.flatMap((result) => validateBundle(manifest, input, result)),
      );
    },
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
}

export function makeVerificationProviderRegistry(
  adapters: readonly VerificationProviderAdapter[],
  options: VerificationProviderRegistryOptions = {},
): Effect.Effect<VerificationProviderRegistryService, VerificationProviderRegistryError> {
  return Effect.gen(function* () {
    const now = options.now ?? Date.now;
    const registered = new Map<string, VerificationProviderAdapter>();
    for (const adapter of adapters) {
      const manifest = yield* validateProofProviderManifest(adapter.manifest);
      if (registered.has(manifest.provider_id)) {
        return yield* Effect.fail(
          new VerificationProviderDuplicate({ provider_id: manifest.provider_id }),
        );
      }
      registered.set(manifest.provider_id, guardAdapter(adapter, manifest, now));
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
