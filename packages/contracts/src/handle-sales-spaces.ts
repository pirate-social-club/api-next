import { parseCanonicalRouteLabelV1 } from "@pirate/route-label-codec";
import { Schema } from "effect";
import {
  BoundedIdentifier,
  CanonicalInstant,
  IdempotencyKey,
  PositiveInteger,
  Sha256Hex,
} from "./handle-sales-scalars.ts";

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
