import { parseCanonicalRouteLabelV1 } from "@pirate/route-label-codec";
import { Schema } from "effect";
import { HandleSafeReasonV2 } from "./errors.ts";
import {
  HandleEligibilitySnapshotV1,
  HandleFreePricingV1,
  HandleGrantPrivateV2,
  HandlePaymentV1,
} from "./handle-sales.ts";
import {
  BoundedIdentifier,
  CanonicalInstant,
  IdempotencyKey,
  PositiveInteger,
  Sha256Hex,
} from "./handle-sales-scalars.ts";
import { PersonaIdV1 } from "./personas.ts";

/**
 * Native Spaces sale-namespace activation (spec 012 §5.3.13.3, §5.3.13.4, and
 * §5.3.13.11). These schemas are the checked Spaces sibling of the HNS
 * activation. They are not wired to any endpoint until the public contract
 * unions land; the HNS wire is unchanged.
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
  grant: Schema.NullOr(HandleGrantPrivateV2),
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
 * wallet satisfies the members-only requirement (§5.3.13.12). Not yet wired to
 * the public endpoint.
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
