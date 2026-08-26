import { Schema } from "effect";
import { Auth } from "./auth.ts";
import { endpoint } from "./endpoint.ts";
import {
  AuthError,
  BadRequest,
  Conflict,
  DirectGrantRecipientUnavailable,
  HandleRequestRejected,
  HandleSafeReasonV2,
  InternalError,
  NotFound,
  RateLimited,
  RetryableHandleRequestRejected,
} from "./errors.ts";
import { PersonaIdV1, PublicPersonaV1 } from "./personas.ts";

const BoundedIdentifier = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
      ? undefined
      : "Expected a bounded identifier",
  ),
);
const IdempotencyKey = Schema.String.check(
  Schema.makeFilter((value) =>
    value.length > 0 &&
    value.length <= 128 &&
    value === value.trim() &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })
      ? undefined
      : "Expected a bounded idempotency key",
  ),
);
const Sha256Hex = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[0-9a-f]{64}$/u.test(value) ? undefined : "Expected a lowercase SHA-256 digest",
  ),
);
const PositiveInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
);
const NonNegativeInteger = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);
const CanonicalInstant = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
      ? undefined
      : "Expected a canonical ISO instant";
  }),
);
const HnsRoot = Schema.String.check(
  Schema.makeFilter((value) =>
    new TextEncoder().encode(value).byteLength <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      ? undefined
      : "Expected a canonical HNS root",
  ),
);
export const HnsHandleLabelV2 = Schema.String.check(
  Schema.makeFilter((value) => {
    const length = new TextEncoder().encode(value).byteLength;
    return length >= 1 &&
      length <= 63 &&
      !value.startsWith("xn--") &&
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
      ? undefined
      : "Expected a canonical HNS subordinate label";
  }),
);
export type HnsHandleLabelV2 = Schema.Schema.Type<typeof HnsHandleLabelV2>;

export const HandleFamilyV1 = Schema.Literals(["hns", "spaces"]);
export const HandleFulfillmentKindV1 = Schema.Literals([
  "hosted_persona_v1",
  "delegated_zone_v1",
  "spaces_native_v1",
]);
export const HandleAllocationKindV1 = Schema.Literals([
  "first_come_v1",
  "direct_grant_v1",
  "auction_v1",
]);

export const CommunityHandleKeyV1 = Schema.Struct({
  family: HandleFamilyV1,
  namespace_root: HnsRoot,
  handle_label: HnsHandleLabelV2,
});
export type CommunityHandleKeyV1 = Schema.Schema.Type<typeof CommunityHandleKeyV1>;

export const HandleFreePricingV1 = Schema.Struct({
  kind: Schema.Literal("free_v1"),
  pricing_id: BoundedIdentifier,
  pricing_revision: PositiveInteger,
  pricing_hash: Sha256Hex,
  atomic_amount: Schema.Literal("0"),
});
export type HandleFreePricingV1 = Schema.Schema.Type<typeof HandleFreePricingV1>;

export const HandleCuratedQualificationPolicyRefV1 = Schema.Struct({
  kind: Schema.Literal("curated_policy_v1"),
  policy_id: BoundedIdentifier,
  policy_revision: PositiveInteger,
  policy_hash: Sha256Hex,
  provider_binding_hash: Sha256Hex,
});
export type HandleCuratedQualificationPolicyRefV1 = Schema.Schema.Type<
  typeof HandleCuratedQualificationPolicyRefV1
>;

export const HandleQualificationPolicyRefV1 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("none_v1"),
    policy_id: BoundedIdentifier,
    policy_revision: PositiveInteger,
    policy_hash: Sha256Hex,
  }),
  HandleCuratedQualificationPolicyRefV1,
]);
export type HandleQualificationPolicyRefV1 = Schema.Schema.Type<
  typeof HandleQualificationPolicyRefV1
>;

export const HandleLabelGrammarIdV2 = Schema.Literal("hns_ascii_ldh_1_63_v1");
export const HandleAvailabilityRuleV1 = Schema.Struct({
  kind: Schema.Literal("length_band_v1"),
  min_label_length: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 32 })),
  max_label_length: Schema.Int.check(Schema.isBetween({ minimum: 8, maximum: 32 })),
}).check(
  Schema.makeFilter(({ min_label_length, max_label_length }) =>
    min_label_length <= max_label_length ? undefined : "Expected an ordered availability band",
  ),
);

export const HandleLabelScopeV2 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exact_label_v2"),
    label_grammar_id: HandleLabelGrammarIdV2,
    handle_label: HnsHandleLabelV2,
    reserved_labels_id: BoundedIdentifier,
    reserved_labels_revision: PositiveInteger,
    reserved_labels_hash: Sha256Hex,
  }),
  Schema.Struct({
    kind: Schema.Literal("label_rule_v2"),
    label_grammar_id: HandleLabelGrammarIdV2,
    reserved_labels_id: BoundedIdentifier,
    reserved_labels_revision: PositiveInteger,
    reserved_labels_hash: Sha256Hex,
    availability: HandleAvailabilityRuleV1,
  }),
]);
export type HandleLabelScopeV2 = Schema.Schema.Type<typeof HandleLabelScopeV2>;

const HandleLabelScopeCommandV2 = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exact_label_v2"),
    label_grammar_id: HandleLabelGrammarIdV2,
    handle_label: HnsHandleLabelV2,
    reserved_labels_id: BoundedIdentifier,
    expected_reserved_labels_revision: PositiveInteger,
  }),
  Schema.Struct({
    kind: Schema.Literal("label_rule_v2"),
    label_grammar_id: HandleLabelGrammarIdV2,
    reserved_labels_id: BoundedIdentifier,
    expected_reserved_labels_revision: PositiveInteger,
    availability: HandleAvailabilityRuleV1,
  }),
]);
export type HandleLabelScopeCommandV2 = Schema.Schema.Type<typeof HandleLabelScopeCommandV2>;

export const SaleNamespaceActivationV1 = Schema.Struct({
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  sale_namespace_activation_hash: Sha256Hex,
  community_id: BoundedIdentifier,
  family: Schema.Literal("hns"),
  canonical_root: HnsRoot,
  display_root: Schema.String,
  namespace_authority: Schema.Struct({
    kind: Schema.Literal("verified_namespace_v1"),
    namespace_authority_reference: BoundedIdentifier,
    namespace_authority_generation: PositiveInteger,
  }),
  serving: Schema.Struct({
    kind: Schema.Literal("hns_dns_zone_activation_v1"),
    dns_zone_activation_id: BoundedIdentifier,
    dns_zone_activation_generation: PositiveInteger,
  }),
  root_replacement: Schema.Struct({
    kind: Schema.Literal("dedicated_root_replace_v1"),
    confirmed: Schema.Literal(true),
  }),
  status: Schema.Literals(["pending", "active", "suspended", "revoked"]),
  created_at: CanonicalInstant,
  activated_at: Schema.NullOr(CanonicalInstant),
  suspended_at: Schema.NullOr(CanonicalInstant),
  revoked_at: Schema.NullOr(CanonicalInstant),
});
export type SaleNamespaceActivationV1 = Schema.Schema.Type<typeof SaleNamespaceActivationV1>;

const SaleNamespaceAuthorityCommandV1 = {
  namespace_authority_reference: BoundedIdentifier,
  expected_namespace_authority_generation: PositiveInteger,
  dns_zone_activation_id: BoundedIdentifier,
  expected_dns_zone_activation_generation: PositiveInteger,
  dedicated_root_replacement_confirmed: Schema.Literal(true),
} as const;

const MutateSaleNamespaceResultV1 = Schema.Struct({
  activation: SaleNamespaceActivationV1,
  replayed: Schema.Boolean,
});

export const CommunityHandleOfferingV2 = Schema.Struct({
  offering_id: BoundedIdentifier,
  offering_revision: PositiveInteger,
  offering_hash: Sha256Hex,
  community_id: BoundedIdentifier,
  family: HandleFamilyV1,
  namespace_root: HnsRoot,
  display_root: Schema.String,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  label_scope: HandleLabelScopeV2,
  allocation: Schema.Struct({ kind: HandleAllocationKindV1 }),
  max_active_grants_per_account: Schema.NullOr(PositiveInteger),
  fulfillment: Schema.Struct({ kind: HandleFulfillmentKindV1 }),
  qualification_policy: HandleQualificationPolicyRefV1,
  pricing: HandleFreePricingV1,
  issuance: Schema.Struct({
    family: HandleFamilyV1,
    driver_id: BoundedIdentifier,
    driver_version: BoundedIdentifier,
  }),
  quote_ttl_seconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 900 })),
  reservation_ttl_seconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 300 })),
  status: Schema.Literals(["active", "paused", "retired"]),
  created_at: CanonicalInstant,
});
export type CommunityHandleOfferingV2 = Schema.Schema.Type<typeof CommunityHandleOfferingV2>;

const HandleOfferingTermsCommandV2 = Schema.Struct({
  sale_namespace_activation_id: BoundedIdentifier,
  expected_sale_namespace_activation_generation: PositiveInteger,
  label_scope: HandleLabelScopeCommandV2,
  allocation_kind: HandleAllocationKindV1,
  max_active_grants_per_account: Schema.optional(Schema.NullOr(PositiveInteger)),
  fulfillment_kind: HandleFulfillmentKindV1,
  qualification_policy_id: BoundedIdentifier,
  expected_qualification_policy_revision: PositiveInteger,
  pricing_id: BoundedIdentifier,
  expected_pricing_revision: PositiveInteger,
  issuance_driver_id: BoundedIdentifier,
  expected_issuance_driver_version: BoundedIdentifier,
  quote_ttl_seconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 900 })),
  reservation_ttl_seconds: Schema.Int.check(Schema.isBetween({ minimum: 30, maximum: 300 })),
});
export type HandleOfferingTermsCommandV2 = Schema.Schema.Type<typeof HandleOfferingTermsCommandV2>;

const MutateHandleOfferingResultV2 = Schema.Struct({
  offering: CommunityHandleOfferingV2,
  replayed: Schema.Boolean,
});

export const HandleEligibilitySnapshotV1 = Schema.Struct({
  policy_revision: PositiveInteger,
  policy_hash: Sha256Hex,
  decision: Schema.Literal("passed"),
  evidence_use_ids: Schema.Array(BoundedIdentifier),
  evaluated_at: CanonicalInstant,
});

export const HandleQuoteV2 = Schema.Struct({
  quote_id: BoundedIdentifier,
  quote_hash: Sha256Hex,
  offering_id: BoundedIdentifier,
  offering_revision: PositiveInteger,
  offering_hash: Sha256Hex,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  fulfillment: Schema.Struct({ kind: HandleFulfillmentKindV1 }),
  owner_persona_id: PersonaIdV1,
  handle: CommunityHandleKeyV1,
  display_identifier: Schema.String,
  pricing: HandleFreePricingV1,
  eligibility: HandleEligibilitySnapshotV1,
  status: Schema.Literals(["quoted", "expired", "consumed"]),
  quoted_at: CanonicalInstant,
  expires_at: CanonicalInstant,
});
export type HandleQuoteV2 = Schema.Schema.Type<typeof HandleQuoteV2>;

export const CreateHandleQuoteResultV2 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("quoted"), quote: HandleQuoteV2, replayed: Schema.Boolean }),
  Schema.Struct({
    kind: Schema.Literal("eligibility_required"),
    offering_id: BoundedIdentifier,
    owner_persona_id: PersonaIdV1,
    reason: Schema.Literals(["evidence_required", "qualification_unsatisfied"]),
  }),
]);

export const HandleReservationV2 = Schema.Struct({
  reservation_id: BoundedIdentifier,
  reservation_hash: Sha256Hex,
  quote_id: BoundedIdentifier,
  quote_hash: Sha256Hex,
  offering_id: BoundedIdentifier,
  offering_hash: Sha256Hex,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  fulfillment: Schema.Struct({ kind: HandleFulfillmentKindV1 }),
  owner_persona_id: PersonaIdV1,
  handle: CommunityHandleKeyV1,
  status: Schema.Literals(["reserved", "consumed", "expired", "cancelled", "blocked"]),
  reserved_at: CanonicalInstant,
  expires_at: CanonicalInstant,
});
export type HandleReservationV2 = Schema.Schema.Type<typeof HandleReservationV2>;

export const HandlePaymentV1 = Schema.Struct({
  kind: Schema.Literal("not_required_v1"),
  pricing_revision: PositiveInteger,
  pricing_hash: Sha256Hex,
  atomic_amount: Schema.Literal("0"),
  status: Schema.Literal("not_applicable"),
});

export const HandleGrantPrivateV2 = Schema.Struct({
  grant_id: BoundedIdentifier,
  grant_generation: PositiveInteger,
  community_id: BoundedIdentifier,
  offering_id: BoundedIdentifier,
  offering_hash: Sha256Hex,
  claim_id: BoundedIdentifier,
  owner_persona_id: PersonaIdV1,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  fulfillment: Schema.Struct({ kind: HandleFulfillmentKindV1 }),
  handle: CommunityHandleKeyV1,
  display_identifier: Schema.String,
  status: Schema.Literals(["active", "revoked", "tombstoned"]),
  issued_at: CanonicalInstant,
});
export type HandleGrantPrivateV2 = Schema.Schema.Type<typeof HandleGrantPrivateV2>;

export const HandleClaimV2 = Schema.Struct({
  claim_id: BoundedIdentifier,
  owner_persona_id: PersonaIdV1,
  offering_id: BoundedIdentifier,
  offering_hash: Sha256Hex,
  quote_id: BoundedIdentifier,
  reservation_id: BoundedIdentifier,
  reservation_hash: Sha256Hex,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  fulfillment: Schema.Struct({ kind: HandleFulfillmentKindV1 }),
  handle: CommunityHandleKeyV1,
  display_identifier: Schema.String,
  payment: HandlePaymentV1,
  state: Schema.Literals(["issuance_pending", "issued", "blocked", "issuance_failed"]),
  safe_reason: Schema.NullOr(HandleSafeReasonV2),
  grant: Schema.NullOr(HandleGrantPrivateV2),
  created_at: CanonicalInstant,
  updated_at: CanonicalInstant,
});
export type HandleClaimV2 = Schema.Schema.Type<typeof HandleClaimV2>;

export const HandleHostProjectionV1 = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("not_applicable") }),
  Schema.Struct({
    kind: Schema.Literal("available"),
    normalized_host: Schema.String,
    sale_namespace_activation_generation: PositiveInteger,
    grant_generation: PositiveInteger,
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    reason: Schema.Literals([
      "namespace_suspended",
      "namespace_authority_lost",
      "sale_namespace_inactive",
      "dns_or_gateway_unhealthy",
      "host_not_activated",
    ]),
  }),
]);

export const PublicHandleGrantV2 = Schema.Struct({
  grant_id: BoundedIdentifier,
  grant_generation: PositiveInteger,
  community_id: BoundedIdentifier,
  owner_persona: PublicPersonaV1,
  handle: CommunityHandleKeyV1,
  display_identifier: Schema.String,
  host: HandleHostProjectionV1,
  issued_at: CanonicalInstant,
});
export type PublicHandleGrantV2 = Schema.Schema.Type<typeof PublicHandleGrantV2>;

/** Complete public grant projection required by the handle-host runtime. */
export const PublicHandleGrantV3 = Schema.Struct({
  grant_id: BoundedIdentifier,
  grant_generation: PositiveInteger,
  community_id: BoundedIdentifier,
  owner_persona: PublicPersonaV1,
  sale_namespace_activation_id: BoundedIdentifier,
  sale_namespace_activation_generation: PositiveInteger,
  fulfillment: Schema.Struct({ kind: HandleFulfillmentKindV1 }),
  handle: CommunityHandleKeyV1,
  display_identifier: Schema.String,
  host: HandleHostProjectionV1,
  issued_at: CanonicalInstant,
});
export type PublicHandleGrantV3 = Schema.Schema.Type<typeof PublicHandleGrantV3>;

const NullablePublicProfileText = (maximumLength: number, label: string) =>
  Schema.NullOr(
    Schema.String.check(
      Schema.makeFilter((value) =>
        value.length <= maximumLength &&
        ![...value].some((character) => {
          const code = character.charCodeAt(0);
          return code === 0 || code === 0x7f;
        })
          ? undefined
          : `Expected bounded ${label}`,
      ),
    ),
  );

export const PublicPersonaProfileV1 = Schema.Struct({
  persona: PublicPersonaV1,
  profile: Schema.Struct({
    revision: PositiveInteger,
    cover_ref: NullablePublicProfileText(2_048, "cover reference"),
    bio: NullablePublicProfileText(2_000, "bio"),
  }),
  handle_grants: Schema.Array(PublicHandleGrantV3),
});
export type PublicPersonaProfileV1 = Schema.Schema.Type<typeof PublicPersonaProfileV1>;

const page = <T>(item: Schema.Schema<T>) =>
  Schema.Struct({ items: Schema.Array(item), next_cursor: Schema.NullOr(BoundedIdentifier) });

const CommunityPath = Schema.Struct({ communityId: BoundedIdentifier });
const ActivationPath = Schema.Struct({
  communityId: BoundedIdentifier,
  activationId: BoundedIdentifier,
});
const OfferingPath = Schema.Struct({
  communityId: BoundedIdentifier,
  offeringId: BoundedIdentifier,
});
const ClaimPath = Schema.Struct({ claimId: BoundedIdentifier });
const PersonaPath = Schema.Struct({ personaId: PersonaIdV1 });
const HandlePath = Schema.Struct({
  family: HandleFamilyV1,
  namespaceRoot: HnsRoot,
  handleLabel: HnsHandleLabelV2,
});
const PageQuery = Schema.Struct({
  limit: Schema.optional(
    Schema.String.check(
      Schema.makeFilter((value) =>
        /^(?:[1-9]|[1-9][0-9]|100)$/u.test(value) ? undefined : "Expected a limit from 1 to 100",
      ),
    ),
  ),
  cursor: Schema.optional(BoundedIdentifier),
});

const handleMutationErrors = [
  AuthError,
  BadRequest,
  Conflict,
  HandleRequestRejected,
  RetryableHandleRequestRejected,
  RateLimited,
  InternalError,
] as const;

export const CreateHandleSaleNamespace = endpoint({
  method: "POST",
  path: "/communities/:communityId/handle-sale-namespaces",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPath,
    body: Schema.Struct({ idempotency_key: IdempotencyKey, ...SaleNamespaceAuthorityCommandV1 }),
  },
  response: MutateSaleNamespaceResultV1,
  successStatus: [200, 201],
  errors: handleMutationErrors,
});

export const ReviseHandleSaleNamespace = endpoint({
  method: "POST",
  path: "/communities/:communityId/handle-sale-namespaces/:activationId/revisions",
  auth: Auth.userOrAdmin(),
  request: {
    path: ActivationPath,
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      expected_sale_namespace_activation_hash: Sha256Hex,
      requested_status: Schema.Literals(["active", "suspended", "revoked"]),
      ...SaleNamespaceAuthorityCommandV1,
    }),
  },
  response: MutateSaleNamespaceResultV1,
  successStatus: [200, 201],
  errors: handleMutationErrors,
});

export const ListHandleSaleNamespaces = endpoint({
  method: "GET",
  path: "/communities/:communityId/handle-sale-namespaces",
  auth: Auth.public(),
  request: { path: CommunityPath, query: PageQuery },
  response: page(SaleNamespaceActivationV1),
  errors: [BadRequest, InternalError],
});

export const CreateHandleDirectGrantRecipientToken = endpoint({
  method: "POST",
  path: "/communities/:communityId/handle-direct-grant-recipient-tokens",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPath,
    body: Schema.Struct({ idempotency_key: IdempotencyKey }),
  },
  response: Schema.Struct({
    recipient_token: Schema.String.check(
      Schema.makeFilter((value) =>
        /^hgrt_[A-Za-z0-9_-]{43}$/u.test(value) ? undefined : "Expected a recipient token",
      ),
    ),
    expires_at: CanonicalInstant,
  }),
  successStatus: [200, 201],
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    HandleRequestRejected,
    RetryableHandleRequestRejected,
    RateLimited,
    InternalError,
  ],
});

export const CreateHandleQualificationPolicy = endpoint({
  method: "POST",
  path: "/communities/:communityId/handle-qualification-policies",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPath,
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      requirement: Schema.Struct({
        kind: Schema.Literal("account_allowlist_v1"),
        recipient_token: Schema.String.check(
          Schema.makeFilter((value) =>
            /^hgrt_[A-Za-z0-9_-]{43}$/u.test(value) ? undefined : "Expected a recipient token",
          ),
        ),
      }),
      expected_account_directory_binding_version: BoundedIdentifier,
    }),
  },
  response: Schema.Struct({
    kind: Schema.Literal("account_allowlist_policy_authored_v2"),
    request_hash: Sha256Hex,
    qualification_policy: HandleCuratedQualificationPolicyRefV1,
    created_at: CanonicalInstant,
    replayed: Schema.Boolean,
  }),
  successStatus: [200, 201],
  errors: [
    AuthError,
    BadRequest,
    Conflict,
    DirectGrantRecipientUnavailable,
    HandleRequestRejected,
    RetryableHandleRequestRejected,
    RateLimited,
    InternalError,
  ],
});

export const CreateCommunityHandleOffering = endpoint({
  method: "POST",
  path: "/communities/:communityId/handle-offerings",
  auth: Auth.userOrAdmin(),
  request: {
    path: CommunityPath,
    body: Schema.Struct({ idempotency_key: IdempotencyKey, terms: HandleOfferingTermsCommandV2 }),
  },
  response: MutateHandleOfferingResultV2,
  successStatus: [200, 201],
  errors: handleMutationErrors,
});

export const ReviseCommunityHandleOffering = endpoint({
  method: "POST",
  path: "/communities/:communityId/handle-offerings/:offeringId/revisions",
  auth: Auth.userOrAdmin(),
  request: {
    path: OfferingPath,
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      expected_offering_hash: Sha256Hex,
      requested_status: Schema.Literals(["active", "paused", "retired"]),
      terms: HandleOfferingTermsCommandV2,
    }),
  },
  response: MutateHandleOfferingResultV2,
  successStatus: [200, 201],
  errors: handleMutationErrors,
});

export const ListCommunityHandleOfferings = endpoint({
  method: "GET",
  path: "/communities/:communityId/handle-offerings",
  auth: Auth.public(),
  request: { path: CommunityPath, query: PageQuery },
  response: page(CommunityHandleOfferingV2),
  errors: [BadRequest, InternalError],
});

export const ConfirmHandlePersonaReuse = endpoint({
  method: "POST",
  path: "/handle-persona-link-confirmations",
  auth: Auth.userOrAdmin(),
  request: {
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      persona_id: PersonaIdV1,
      offering_id: BoundedIdentifier,
      confirmed: Schema.Literal(true),
    }),
  },
  response: Schema.Struct({
    confirmation_id: BoundedIdentifier,
    confirmation_hash: Sha256Hex,
    persona_id: PersonaIdV1,
    offering_id: BoundedIdentifier,
    target_community_id: BoundedIdentifier,
    family: HandleFamilyV1,
    namespace_root: HnsRoot,
    public_linkage_generation: NonNegativeInteger,
    persona_public_identity_digest: Sha256Hex,
    status: Schema.Literals(["available", "consumed", "expired"]),
    confirmed_at: CanonicalInstant,
    expires_at: CanonicalInstant,
    replayed: Schema.Boolean,
  }),
  successStatus: [200, 201],
  errors: handleMutationErrors,
});

export const CreateHandleQuote = endpoint({
  method: "POST",
  path: "/handle-quotes",
  auth: Auth.userOrAdmin(),
  request: {
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      persona_id: PersonaIdV1,
      offering_id: BoundedIdentifier,
      desired_label: HnsHandleLabelV2,
    }),
  },
  response: CreateHandleQuoteResultV2,
  successStatus: [200, 201],
  errors: handleMutationErrors,
});

export const CreateHandleReservation = endpoint({
  method: "POST",
  path: "/handle-reservations",
  auth: Auth.userOrAdmin(),
  request: {
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      persona_id: PersonaIdV1,
      quote_id: BoundedIdentifier,
      expected_quote_hash: Sha256Hex,
    }),
  },
  response: Schema.Struct({ reservation: HandleReservationV2, replayed: Schema.Boolean }),
  successStatus: [200, 201],
  errors: handleMutationErrors,
});

export const SubmitFreeHandleClaim = endpoint({
  method: "POST",
  path: "/handle-claims",
  auth: Auth.userOrAdmin(),
  request: {
    body: Schema.Struct({
      idempotency_key: IdempotencyKey,
      persona_id: PersonaIdV1,
      reservation_id: BoundedIdentifier,
      expected_reservation_hash: Sha256Hex,
    }),
  },
  response: Schema.Struct({ claim: HandleClaimV2, replayed: Schema.Boolean }),
  successStatus: [200, 201],
  errors: handleMutationErrors,
});

export const GetHandleClaim = endpoint({
  method: "GET",
  path: "/handle-claims/:claimId",
  auth: Auth.userOrAdmin(),
  request: { path: ClaimPath },
  response: HandleClaimV2,
  errors: [AuthError, BadRequest, NotFound, InternalError],
});

export const ListPersonaHandleGrants = endpoint({
  method: "GET",
  path: "/personas/:personaId/handle-grants",
  auth: Auth.public(),
  request: { path: PersonaPath, query: PageQuery },
  response: page(PublicHandleGrantV3),
  errors: [BadRequest, InternalError],
});

export const GetPublicHandleGrant = endpoint({
  method: "GET",
  path: "/handles/:family/:namespaceRoot/:handleLabel",
  auth: Auth.public(),
  request: {
    path: HandlePath,
    exactRawPathParameters: ["family", "namespaceRoot", "handleLabel"],
  },
  response: PublicHandleGrantV3,
  errors: [BadRequest, NotFound, InternalError],
});

export const GetPublicPersona = endpoint({
  method: "GET",
  path: "/public-personas/:personaId",
  auth: Auth.public(),
  request: { path: PersonaPath },
  response: PublicPersonaProfileV1,
  errors: [BadRequest, NotFound, InternalError],
});

export const handleSalesRegistry = {
  CreateHandleSaleNamespace,
  ReviseHandleSaleNamespace,
  ListHandleSaleNamespaces,
  CreateHandleDirectGrantRecipientToken,
  CreateHandleQualificationPolicy,
  CreateCommunityHandleOffering,
  ReviseCommunityHandleOffering,
  ListCommunityHandleOfferings,
  ConfirmHandlePersonaReuse,
  CreateHandleQuote,
  CreateHandleReservation,
  SubmitFreeHandleClaim,
  GetHandleClaim,
  ListPersonaHandleGrants,
  GetPublicHandleGrant,
  GetPublicPersona,
} as const;
