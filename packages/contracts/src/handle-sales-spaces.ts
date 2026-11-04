import { parseCanonicalRouteLabelV1 } from "@pirate/route-label-codec";
import { Schema } from "effect";
import { HandleSafeReasonV2 } from "./errors.ts";
import { HandleNationalityRequiredV1 } from "./handle-nationality.ts";
import {
  CommunityHandleKeyV1,
  CommunityHandleOfferingManagementItemV2,
  CommunityHandleOfferingV2,
  CommunityHandleOfferingV3,
  HandleAvailabilityRuleV1,
  HandleClaimV2,
  HandleCuratedQualificationPolicyRefV1,
  HandleEligibilitySnapshotV1,
  HandleFreePricingV1,
  HandleGrantPrivateV2,
  HandleOfferingAuthoringPresetV1,
  HandlePaymentV1,
  HandleQuoteV2,
  HandleQuoteV3,
  HandleReservationV2,
  HandleSaleNamespaceCandidateV1,
  HandleSaleNamespaceManagementItemV1,
  PublicHandleGrantV3,
  PublicPersonaProfileV1,
  SaleNamespaceActivationV1,
} from "./handle-sales.ts";
import {
  BoundedIdentifier,
  CanonicalInstant,
  IdempotencyKey,
  NonNegativeInteger,
  PositiveInteger,
  Sha256Hex,
} from "./handle-sales-scalars.ts";
import { PersonaIdV1 } from "./personas.ts";

/**
 * Native Spaces sale-namespace activation (spec 012 §5.3.13.3, §5.3.13.4, and
 * §5.3.13.11). These schemas are the checked Spaces sibling of the HNS
 * activation. Public successor contracts admit it alongside the HNS wire.
 */

export const SpacesNetworkV1 = Schema.Literals(["mainnet", "testnet4", "regtest"]);
export type SpacesNetworkV1 = Schema.Schema.Type<typeof SpacesNetworkV1>;

/** The §2.2 canonical Spaces root rule; IDN roots keep their ACE form. */
export const SpacesCanonicalRootV1 = Schema.String.check(
  Schema.makeFilter((value) =>
    parseCanonicalRouteLabelV1("spaces", value).kind === "accepted"
      ? undefined
      : "Expected a canonical Spaces root within 62 bytes",
  ),
);

export const SpacesOperatorAssignmentRefV1 = Schema.Struct({
  kind: Schema.Literal("spaces_operator_assignment_v1"),
  operator_assignment_id: BoundedIdentifier,
  operator_assignment_generation: PositiveInteger,
});
export type SpacesOperatorAssignmentRefV1 = Schema.Schema.Type<
  typeof SpacesOperatorAssignmentRefV1
>;

export const SpacesOperatorFundingTermsV1 = Schema.Struct({
  kind: Schema.Literal("spaces_operator_funding_confirm_v1"),
  confirmed: Schema.Literal(true),
});

export const SpacesSaleNamespaceActivationV1 = Schema.Struct({
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  sale_namespace_activation_hash: Sha256Hex,
  community_id: BoundedIdentifier,
  family: Schema.Literal("spaces"),
  network: SpacesNetworkV1,
  canonical_root: SpacesCanonicalRootV1,
  display_root: Schema.String,
  namespace_authority: Schema.Struct({
    kind: Schema.Literal("verified_namespace_v1"),
    namespace_authority_reference: BoundedIdentifier,
    namespace_authority_generation: PositiveInteger,
  }),
  operator: SpacesOperatorAssignmentRefV1,
  operator_funding_terms: SpacesOperatorFundingTermsV1,
  status: Schema.Literals(["pending", "active", "suspended", "revoked"]),
  created_at: CanonicalInstant,
  activated_at: Schema.NullOr(CanonicalInstant),
  suspended_at: Schema.NullOr(CanonicalInstant),
  revoked_at: Schema.NullOr(CanonicalInstant),
});
export type SpacesSaleNamespaceActivationV1 = Schema.Schema.Type<
  typeof SpacesSaleNamespaceActivationV1
>;

export const SaleNamespaceActivationV2 = Schema.Union([
  SaleNamespaceActivationV1,
  SpacesSaleNamespaceActivationV1,
]);
export type SaleNamespaceActivationV2 = Schema.Schema.Type<typeof SaleNamespaceActivationV2>;

/** The owner command. Network, roots, authority, assignment, and hashes are server-resolved. */
export const CreateSpacesSaleNamespaceActivationV1 = Schema.Struct({
  idempotency_key: IdempotencyKey,
  family: Schema.Literal("spaces"),
  namespace_authority_reference: BoundedIdentifier,
  expected_namespace_authority_generation: PositiveInteger,
  operator_assignment_id: BoundedIdentifier,
  expected_operator_assignment_generation: PositiveInteger,
  operator_funding_terms_confirmed: Schema.Literal(true),
});
export type CreateSpacesSaleNamespaceActivationV1 = Schema.Schema.Type<
  typeof CreateSpacesSaleNamespaceActivationV1
>;

/** The owner sees one reason at a time, in this ratified order. */
export const SpacesSaleReadinessReasonV1 = Schema.Literals([
  "namespace_authority_unavailable",
  "owner_challenge_required",
  "anchor_pending",
  "publication_unverified",
  "delegation_required",
  "operator_capability_unverified",
  "commitment_history_unverified",
  "driver_disabled",
]);
export type SpacesSaleReadinessReasonV1 = Schema.Schema.Type<typeof SpacesSaleReadinessReasonV1>;

export const SpacesSaleReadinessV1 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("ready_v1") }),
  Schema.Struct({ kind: Schema.Literal("not_ready_v1"), reason: SpacesSaleReadinessReasonV1 }),
]);
export type SpacesSaleReadinessV1 = Schema.Schema.Type<typeof SpacesSaleReadinessV1>;

const NonNegativeDecimalSats = Schema.String.check(
  Schema.makeFilter((value) =>
    /^(?:0|[1-9][0-9]{0,19})$/u.test(value)
      ? undefined
      : "Expected a non-negative decimal satoshi amount",
  ),
);

/**
 * The owner funding projection. It exposes no wallet identifier, recovery
 * material, operator host, or credential; the top-up address is null while
 * owner deposits are disabled.
 */
export const SpacesOperatorFundingV1 = Schema.Struct({
  status: Schema.Literals(["funded_v1", "commits_paused_insufficient_funds_v1"]),
  confirmed_balance_sats: NonNegativeDecimalSats,
  top_up_address: Schema.NullOr(Schema.String),
  observed_at: CanonicalInstant,
});
export type SpacesOperatorFundingV1 = Schema.Schema.Type<typeof SpacesOperatorFundingV1>;

export const HandleSaleNamespaceCandidateV2 = Schema.Union([
  HandleSaleNamespaceCandidateV1,
  Schema.Struct({
    kind: Schema.Literal("ready_v1"),
    family: Schema.Literal("spaces"),
    network: SpacesNetworkV1,
    canonical_root: SpacesCanonicalRootV1,
    display_root: Schema.String,
    namespace_authority_reference: BoundedIdentifier,
    expected_namespace_authority_generation: PositiveInteger,
    operator_assignment_id: BoundedIdentifier,
    expected_operator_assignment_generation: PositiveInteger,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable_v1"),
    family: Schema.Literal("spaces"),
    network: SpacesNetworkV1,
    canonical_root: SpacesCanonicalRootV1,
    display_root: Schema.String,
    reason: SpacesSaleReadinessReasonV1,
  }),
]);
export type HandleSaleNamespaceCandidateV2 = Schema.Schema.Type<
  typeof HandleSaleNamespaceCandidateV2
>;

export const HandleOfferingAuthoringPresetV2 = Schema.Union([
  HandleOfferingAuthoringPresetV1,
  Schema.Struct({
    kind: Schema.Literal("spaces_native_free_v1"),
    reserved_labels_id: BoundedIdentifier,
    expected_reserved_labels_revision: PositiveInteger,
    broad_qualification_policy_id: BoundedIdentifier,
    expected_broad_qualification_policy_revision: PositiveInteger,
    pricing_id: BoundedIdentifier,
    expected_pricing_revision: PositiveInteger,
    issuance_driver_id: BoundedIdentifier,
    expected_issuance_driver_version: BoundedIdentifier,
    quote_ttl_seconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 900 })),
    reservation_ttl_seconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 300 })),
  }),
]);
export type HandleOfferingAuthoringPresetV2 = Schema.Schema.Type<
  typeof HandleOfferingAuthoringPresetV2
>;

export const HandleSalesManagementContextV2 = Schema.Struct({
  community_id: BoundedIdentifier,
  sale_namespace_candidates: Schema.Array(HandleSaleNamespaceCandidateV2),
  offering_authoring_presets: Schema.Array(HandleOfferingAuthoringPresetV2),
  observed_at: CanonicalInstant,
});
export type HandleSalesManagementContextV2 = Schema.Schema.Type<
  typeof HandleSalesManagementContextV2
>;

export const HandleSaleNamespaceManagementItemV2 = Schema.Union([
  HandleSaleNamespaceManagementItemV1,
  Schema.Struct({
    activation: SpacesSaleNamespaceActivationV1,
    readiness: SpacesSaleReadinessV1,
    funding: SpacesOperatorFundingV1,
    pending_claim_count: NonNegativeInteger,
  }),
]);
export type HandleSaleNamespaceManagementItemV2 = Schema.Schema.Type<
  typeof HandleSaleNamespaceManagementItemV2
>;

/**
 * `spaces_subspace_label_v1` (spec 012 §5.3.13.3): canonical lower-case ASCII
 * letters and digits with interior single hyphens, 1 to 62 bytes, no `xn--`
 * prefix. Client input is never trimmed, case folded, or normalized.
 */
export const SpacesSubspaceLabelV1 = Schema.String.check(
  Schema.makeFilter((value) => {
    const length = new TextEncoder().encode(value).byteLength;
    return length >= 1 &&
      length <= 62 &&
      !value.startsWith("xn--") &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      ? undefined
      : "Expected a canonical Spaces subspace label";
  }),
);

/** The claim identity `(family, namespace_root, handle_label)` for a Spaces name. */
export const SpacesHandleKeyV1 = Schema.Struct({
  family: Schema.Literal("spaces"),
  namespace_root: SpacesCanonicalRootV1,
  handle_label: SpacesSubspaceLabelV1,
});
export type SpacesHandleKeyV1 = Schema.Schema.Type<typeof SpacesHandleKeyV1>;

export const SpacesHandleLabelScopeV1 = Schema.Struct({
  kind: Schema.Literal("label_rule_v2"),
  label_grammar_id: Schema.Literal("spaces_subspace_label_v1"),
  reserved_labels_id: BoundedIdentifier,
  reserved_labels_revision: PositiveInteger,
  reserved_labels_hash: Sha256Hex,
  availability: HandleAvailabilityRuleV1,
});

export const CommunityHandleSpacesOfferingV1 = Schema.Struct({
  ...CommunityHandleOfferingV2.fields,
  family: Schema.Literal("spaces"),
  namespace_root: SpacesCanonicalRootV1,
  label_scope: SpacesHandleLabelScopeV1,
  allocation: Schema.Struct({ kind: Schema.Literal("first_come_v1") }),
  fulfillment: Schema.Struct({ kind: Schema.Literal("spaces_native_v1") }),
  qualification_policy: HandleCuratedQualificationPolicyRefV1,
  issuance: Schema.Struct({
    family: Schema.Literal("spaces"),
    driver_id: BoundedIdentifier,
    driver_version: BoundedIdentifier,
  }),
});
export type CommunityHandleSpacesOfferingV1 = Schema.Schema.Type<
  typeof CommunityHandleSpacesOfferingV1
>;

const HnsFulfillment = Schema.Struct({
  kind: Schema.Literals(["hosted_persona_v1", "delegated_zone_v1"]),
});
const HnsHandle = Schema.Struct({
  ...CommunityHandleKeyV1.fields,
  family: Schema.Literal("hns"),
});
const HnsOfferingFields = {
  family: Schema.Literal("hns"),
  fulfillment: HnsFulfillment,
  issuance: Schema.Struct({
    ...CommunityHandleOfferingV2.fields.issuance.fields,
    family: Schema.Literal("hns"),
  }),
} as const;

export const CommunityHandleOfferingV4 = Schema.Union([
  Schema.Struct({ ...CommunityHandleOfferingV2.fields, ...HnsOfferingFields }),
  Schema.Struct({ ...CommunityHandleOfferingV3.fields, ...HnsOfferingFields }),
  CommunityHandleSpacesOfferingV1,
]);
export type CommunityHandleOfferingV4 = Schema.Schema.Type<typeof CommunityHandleOfferingV4>;

export const CommunityHandleOfferingManagementItemV3 = Schema.Struct({
  offering: CommunityHandleOfferingV4,
  effectiveness: CommunityHandleOfferingManagementItemV2.fields.effectiveness,
});
export type CommunityHandleOfferingManagementItemV3 = Schema.Schema.Type<
  typeof CommunityHandleOfferingManagementItemV3
>;

/**
 * The owner-only recipient of a Spaces quote, reservation, or claim (spec 012
 * §5.3.13.6): the exact P2TR output script of the selected persona's
 * confirmed Taproot assignment. The private assignment id is never exposed,
 * and no public projection serializes the script.
 */
export const HandleSpacesRecipientV1 = Schema.Struct({
  kind: Schema.Literal("persona_taproot_v1"),
  network: SpacesNetworkV1,
  script_pubkey_hex: Schema.String.check(
    Schema.makeFilter((value) =>
      /^5120[0-9a-f]{64}$/u.test(value) ? undefined : "Expected an exact P2TR output script",
    ),
  ),
});
export type HandleSpacesRecipientV1 = Schema.Schema.Type<typeof HandleSpacesRecipientV1>;

/** `HandleSafeReasonV3` of §5.3.13.6. */
export const HandleSafeReasonV3 = Schema.Union([
  HandleSafeReasonV2,
  Schema.Literal("recipient_wallet_required"),
]);
export type HandleSafeReasonV3 = Schema.Schema.Type<typeof HandleSafeReasonV3>;

const SpacesFulfillmentV1 = Schema.Struct({ kind: Schema.Literal("spaces_native_v1") });

export const HandleSpacesGrantPrivateV1 = Schema.Struct({
  ...HandleGrantPrivateV2.fields,
  fulfillment: SpacesFulfillmentV1,
  handle: SpacesHandleKeyV1,
});
export type HandleSpacesGrantPrivateV1 = Schema.Schema.Type<typeof HandleSpacesGrantPrivateV1>;

export const PublicHandleSpacesGrantV1 = Schema.Struct({
  ...PublicHandleGrantV3.fields,
  fulfillment: SpacesFulfillmentV1,
  handle: SpacesHandleKeyV1,
  host: Schema.Struct({ kind: Schema.Literal("not_applicable") }),
});
export type PublicHandleSpacesGrantV1 = Schema.Schema.Type<typeof PublicHandleSpacesGrantV1>;

export const PublicHandleGrantV4 = Schema.Union([
  Schema.Struct({
    ...PublicHandleGrantV3.fields,
    fulfillment: HnsFulfillment,
    handle: HnsHandle,
  }),
  PublicHandleSpacesGrantV1,
]);
export type PublicHandleGrantV4 = Schema.Schema.Type<typeof PublicHandleGrantV4>;

export const PublicPersonaProfileV2 = Schema.Struct({
  ...PublicPersonaProfileV1.fields,
  handle_grants: Schema.Array(PublicHandleGrantV4),
});
export type PublicPersonaProfileV2 = Schema.Schema.Type<typeof PublicPersonaProfileV2>;

/**
 * The spec's `HandleQuoteV3`, named for its family (ruling Q1) so it cannot
 * be confused with the HNS nationality quote successor. It hashes under the
 * Spaces version-3 quote domain.
 */
export const HandleSpacesQuoteV1 = Schema.Struct({
  quote_id: BoundedIdentifier,
  quote_hash: Sha256Hex,
  offering_id: BoundedIdentifier,
  offering_revision: PositiveInteger,
  offering_hash: Sha256Hex,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  fulfillment: SpacesFulfillmentV1,
  owner_persona_id: PersonaIdV1,
  recipient: HandleSpacesRecipientV1,
  handle: SpacesHandleKeyV1,
  display_identifier: Schema.String,
  pricing: HandleFreePricingV1,
  eligibility: HandleEligibilitySnapshotV1,
  status: Schema.Literals(["quoted", "expired", "consumed"]),
  quoted_at: CanonicalInstant,
  expires_at: CanonicalInstant,
});
export type HandleSpacesQuoteV1 = Schema.Schema.Type<typeof HandleSpacesQuoteV1>;

/** The spec's `HandleReservationV3`. */
export const HandleSpacesReservationV1 = Schema.Struct({
  reservation_id: BoundedIdentifier,
  reservation_hash: Sha256Hex,
  quote_id: BoundedIdentifier,
  quote_hash: Sha256Hex,
  offering_id: BoundedIdentifier,
  offering_hash: Sha256Hex,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  fulfillment: SpacesFulfillmentV1,
  owner_persona_id: PersonaIdV1,
  recipient: HandleSpacesRecipientV1,
  handle: SpacesHandleKeyV1,
  status: Schema.Literals(["reserved", "consumed", "expired", "cancelled", "blocked"]),
  reserved_at: CanonicalInstant,
  expires_at: CanonicalInstant,
});
export type HandleSpacesReservationV1 = Schema.Schema.Type<typeof HandleSpacesReservationV1>;

/**
 * The spec's `HandleClaimV3`. A pending claim is private to its owner, and
 * `delayed` is meaningful only while the claim is `issuance_pending`.
 */
export const HandleSpacesClaimV1 = Schema.Struct({
  claim_id: BoundedIdentifier,
  owner_persona_id: PersonaIdV1,
  offering_id: BoundedIdentifier,
  offering_hash: Sha256Hex,
  quote_id: BoundedIdentifier,
  reservation_id: BoundedIdentifier,
  reservation_hash: Sha256Hex,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  fulfillment: SpacesFulfillmentV1,
  recipient: HandleSpacesRecipientV1,
  handle: SpacesHandleKeyV1,
  display_identifier: Schema.String,
  payment: HandlePaymentV1,
  state: Schema.Literals(["issuance_pending", "issued", "issuance_failed"]),
  delayed: Schema.Boolean,
  safe_reason: Schema.NullOr(HandleSafeReasonV3),
  grant: Schema.NullOr(HandleSpacesGrantPrivateV1),
  created_at: CanonicalInstant,
  updated_at: CanonicalInstant,
});
export type HandleSpacesClaimV1 = Schema.Schema.Type<typeof HandleSpacesClaimV1>;

/**
 * Ruling Q2: the selected persona has no confirmed Taproot recipient on the
 * activation's network, so the quote is refused before any write. There is
 * no fallback recipient and no client field names one.
 */
export const HandleRecipientWalletRequiredV1 = Schema.Struct({
  kind: Schema.Literal("recipient_wallet_required"),
  offering_id: BoundedIdentifier,
  owner_persona_id: PersonaIdV1,
  reason: Schema.Literal("recipient_wallet_required"),
});
export type HandleRecipientWalletRequiredV1 = Schema.Schema.Type<
  typeof HandleRecipientWalletRequiredV1
>;

/**
 * Quote results for a `spaces_native_v1` offering. A nonmember receives
 * `qualification_unsatisfied`, never `evidence_required`, because no proof or
 * wallet satisfies the members-only requirement (§5.3.13.12).
 */
export const CreateHandleSpacesQuoteResultV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("quoted"),
    quote: HandleSpacesQuoteV1,
    replayed: Schema.Boolean,
  }),
  HandleRecipientWalletRequiredV1,
  Schema.Struct({
    kind: Schema.Literal("eligibility_required"),
    offering_id: BoundedIdentifier,
    owner_persona_id: PersonaIdV1,
    reason: Schema.Literal("qualification_unsatisfied"),
  }),
]);
export type CreateHandleSpacesQuoteResultV1 = Schema.Schema.Type<
  typeof CreateHandleSpacesQuoteResultV1
>;

export const CreateHandleQuoteResultV4 = Schema.Union([
  HandleNationalityRequiredV1,
  Schema.Struct({
    kind: Schema.Literal("quoted"),
    quote: Schema.Union([
      Schema.Struct({ ...HandleQuoteV2.fields, fulfillment: HnsFulfillment, handle: HnsHandle }),
      Schema.Struct({ ...HandleQuoteV3.fields, fulfillment: HnsFulfillment, handle: HnsHandle }),
    ]),
    replayed: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("eligibility_required"),
    offering_id: BoundedIdentifier,
    owner_persona_id: PersonaIdV1,
    reason: Schema.Literals(["evidence_required", "qualification_unsatisfied"]),
  }),
  CreateHandleSpacesQuoteResultV1,
]);
export const HandleReservationV3 = Schema.Union([
  Schema.Struct({ ...HandleReservationV2.fields, fulfillment: HnsFulfillment, handle: HnsHandle }),
  HandleSpacesReservationV1,
]);
export const HandleClaimV3 = Schema.Union([
  Schema.Struct({
    ...HandleClaimV2.fields,
    fulfillment: HnsFulfillment,
    handle: HnsHandle,
    grant: Schema.NullOr(
      Schema.Struct({
        ...HandleGrantPrivateV2.fields,
        fulfillment: HnsFulfillment,
        handle: HnsHandle,
      }),
    ),
  }),
  HandleSpacesClaimV1,
]);
