import { Schema } from "effect";

/**
 * Claims are the vocabulary understood by the policy engine. Provider names
 * are deliberately absent: adapters declare which of these claims they can
 * produce in their manifest.
 */
export const CanonicalClaimIdentifier = Schema.Literals([
  "human.live",
  "human.personhood",
  "human.unique",
  "credential.subject_unique",
  "document.valid",
  "document.holder_bound",
  "age.minimum",
  "nationality.allowed",
  "gender.marker",
  "asset.ownership",
  "disclosed.predicate",
]);
export type CanonicalClaimIdentifier = Schema.Schema.Type<typeof CanonicalClaimIdentifier>;

export const ClaimCategory = Schema.Literals([
  "liveness",
  "personhood",
  "uniqueness",
  "document",
  "disclosure",
  "asset",
]);
export type ClaimCategory = Schema.Schema.Type<typeof ClaimCategory>;

export const HolderLivenessRequirement = Schema.Literals([
  "required",
  "not_implied",
  "not_applicable",
]);
export type HolderLivenessRequirement = Schema.Schema.Type<typeof HolderLivenessRequirement>;

export const ScopeRequirement = Schema.Literals(["named_issuer_scope", "not_applicable"]);
export type ScopeRequirement = Schema.Schema.Type<typeof ScopeRequirement>;

/** A relying-party scope is distinct from an action-bound scope. */
export const NamedIssuerScope = Schema.Struct({
  kind: Schema.Literal("named"),
  scope_semantics: Schema.Literal("issuer_rp_scope"),
  issuer: Schema.NonEmptyString,
  rp_scope: Schema.NonEmptyString,
});
export type NamedIssuerScope = Schema.Schema.Type<typeof NamedIssuerScope>;

export const NamedIssuerActionScope = Schema.Struct({
  kind: Schema.Literal("named"),
  scope_semantics: Schema.Literal("issuer_rp_action_scope"),
  issuer: Schema.NonEmptyString,
  rp_scope: Schema.NonEmptyString,
  action_scope: Schema.NonEmptyString,
});
export type NamedIssuerActionScope = Schema.Schema.Type<typeof NamedIssuerActionScope>;

/** A proof scope for providers that produce no subject key. */
export const NoSubjectScope = Schema.Struct({
  kind: Schema.Literal("none"),
  issuer: Schema.NonEmptyString,
});
export type NoSubjectScope = Schema.Schema.Type<typeof NoSubjectScope>;

export const SubjectScope = Schema.Union([
  NamedIssuerScope,
  NamedIssuerActionScope,
  NoSubjectScope,
]);
export type SubjectScope = Schema.Schema.Type<typeof SubjectScope>;

/** Assurance describes what was established, not which provider established it. */
export const Assurance = Schema.Literals([
  "holder_live",
  "personhood",
  "document_zk",
  "provider_attested",
]);
export type Assurance = Schema.Schema.Type<typeof Assurance>;

export const PresentationKind = Schema.Literals([
  "redirect",
  "deeplink",
  "embedded_sdk",
  "poll",
  "none",
]);
export type PresentationKind = Schema.Schema.Type<typeof PresentationKind>;

/** Whether a provider expresses a claim through configuration or a runtime query. */
export const VerificationRequestMode = Schema.Literals(["curated", "dynamic"]);
export type VerificationRequestMode = Schema.Schema.Type<typeof VerificationRequestMode>;

const CanonicalProviderConfigurationValue = Schema.NonEmptyString.check(
  Schema.makeFilter((value) =>
    value.trim() === value ? undefined : "Expected a canonical provider configuration value",
  ),
);

/**
 * Opaque, provider-neutral provenance for the exact configuration selected by
 * planning. Managed references cover hosted flows/policies; dynamic references
 * identify the versioned query generator used for a self-served request.
 */
export const ProviderConfigurationRef = Schema.Struct({
  kind: Schema.Literals(["managed", "dynamic"]),
  reference: CanonicalProviderConfigurationValue,
  version: CanonicalProviderConfigurationValue,
});
export type ProviderConfigurationRef = Schema.Schema.Type<typeof ProviderConfigurationRef>;

export const ProviderClaimCapability = Schema.Struct({
  claim_id: CanonicalClaimIdentifier,
  request_modes: Schema.NonEmptyArray(VerificationRequestMode),
});
export type ProviderClaimCapability = Schema.Schema.Type<typeof ProviderClaimCapability>;

/**
 * Providers must declare whether a subject key is scoped to an issuer and RP,
 * to an issuer/RP/action tuple, or is not produced at all.
 */
export const SubjectKeyScopeSemantics = Schema.Literals([
  "issuer_rp_scope",
  "issuer_rp_action_scope",
  "none",
]);
export type SubjectKeyScopeSemantics = Schema.Schema.Type<typeof SubjectKeyScopeSemantics>;

/**
 * Account binding is selected by the Pirate ceremony, never inferred from a
 * provider response. Subject-bearing manifests require `establish` or
 * `recover`; `none` is reserved for manifests that produce no subject key.
 */
export const SubjectBindingIntent = Schema.Literals(["establish", "recover", "none"]);
export type SubjectBindingIntent = Schema.Schema.Type<typeof SubjectBindingIntent>;

export const ClaimCatalogEntry = Schema.Struct({
  id: CanonicalClaimIdentifier,
  category: ClaimCategory,
  scope_requirement: ScopeRequirement,
  holder_liveness: HolderLivenessRequirement,
});
export type ClaimCatalogEntry = Schema.Schema.Type<typeof ClaimCatalogEntry>;

/**
 * This catalog is deliberately data, rather than a provider-specific union.
 * `credential.subject_unique` is distinct from `human.live`: a document
 * credential's stable subject may be accepted by a policy without implying
 * that the holder was live at presentation time.
 */
export const CANONICAL_CLAIM_CATALOG: readonly ClaimCatalogEntry[] = [
  {
    id: "human.live",
    category: "liveness",
    scope_requirement: "named_issuer_scope",
    holder_liveness: "required",
  },
  {
    id: "human.personhood",
    category: "personhood",
    scope_requirement: "named_issuer_scope",
    holder_liveness: "not_implied",
  },
  {
    id: "human.unique",
    category: "uniqueness",
    scope_requirement: "named_issuer_scope",
    holder_liveness: "not_implied",
  },
  {
    id: "credential.subject_unique",
    category: "uniqueness",
    scope_requirement: "named_issuer_scope",
    holder_liveness: "not_implied",
  },
  {
    id: "document.valid",
    category: "document",
    scope_requirement: "not_applicable",
    holder_liveness: "not_implied",
  },
  {
    id: "document.holder_bound",
    category: "document",
    scope_requirement: "not_applicable",
    holder_liveness: "not_implied",
  },
  {
    id: "age.minimum",
    category: "document",
    scope_requirement: "not_applicable",
    holder_liveness: "not_implied",
  },
  {
    id: "nationality.allowed",
    category: "document",
    scope_requirement: "not_applicable",
    holder_liveness: "not_implied",
  },
  {
    id: "gender.marker",
    category: "document",
    scope_requirement: "not_applicable",
    holder_liveness: "not_implied",
  },
  {
    id: "asset.ownership",
    category: "asset",
    scope_requirement: "not_applicable",
    holder_liveness: "not_applicable",
  },
  {
    id: "disclosed.predicate",
    category: "disclosure",
    scope_requirement: "not_applicable",
    holder_liveness: "not_implied",
  },
];

/** A proof manifest is provider-neutral: `provider_id` is data, never an enum. */
export const ProofProviderManifest = Schema.Struct({
  provider_id: Schema.NonEmptyString,
  manifest_version: Schema.NonEmptyString,
  protocol_versions: Schema.Array(Schema.NonEmptyString),
  environments: Schema.Array(Schema.NonEmptyString),
  supported_methods: Schema.Array(Schema.NonEmptyString),
  claim_ids: Schema.Array(CanonicalClaimIdentifier),
  claim_capabilities: Schema.Array(ProviderClaimCapability),
  presentation_kinds: Schema.Array(PresentationKind),
  assurance_levels: Schema.Array(Assurance),
  subject_key_scope_semantics: SubjectKeyScopeSemantics,
});
export type ProofProviderManifest = Schema.Schema.Type<typeof ProofProviderManifest>;
