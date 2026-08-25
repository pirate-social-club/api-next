import { describe, expect, test } from "bun:test";
import {
  assertCanonicalHnsHandleLabelV2,
  assertHandleOfferingCombinationV2,
  assertRequestedOfferingIsEffectiveV2,
  classifyEffectiveHandleOfferingV2,
  type HandleLabelScopeV2,
  handleAccountAllowlistPolicyHash,
  handleAccountAllowlistPolicyRequestV1Hash,
  handleAccountAllowlistPolicyRequestV2Hash,
  handleAccountDirectoryBindingHash,
  handleClaimRequestHash,
  handleDirectGrantQualificationHash,
  handleDirectGrantRecipientTokenRequestHash,
  handleFreePricingRevisionHash,
  handleGrantFinalizeV1Hash,
  handleGrantFinalizeV2Hash,
  handleOfferingRevisionV1Hash,
  handleOfferingRevisionV2Hash,
  handlePersonaLinkConfirmationRequestHash,
  handlePersonaPublicIdentityHash,
  handleQuoteRequestHash,
  handleQuoteV2Hash,
  handleReservationRequestHash,
  handleReservationV2Hash,
  handleSaleNamespaceActivationHash,
  resolvedHandleAccountCap,
  transitionHandleSaleActivationV1,
} from "./sales-v2.ts";

const one = "1".repeat(64);
const two = "2".repeat(64);
const three = "3".repeat(64);
const four = "4".repeat(64);
const pricingHash = "cb24f410dbe3ea268df0ea438d56c48dc060f2319794ab2913717585b74809f8";
const offeringV2Hash = "92af93ca7d8a00358336f45b8cf947a4ea017de28c53c6a647184d6796871bdb";
const quoteV2Hash = "632f4e125349e24b556954664be0cb719fd911cfc75f0aecf63f91a523beebcc";
const reservationV2Hash = "bdf5042d1c85b6d5eaf56a27d49b792198c0f88253f1714aed76bb291b7a9976";

const broadScope: HandleLabelScopeV2 = {
  kind: "label_rule_v2",
  label_grammar_id: "hns_ascii_ldh_1_63_v1",
  reserved_labels_id: "reserved_labels_01",
  reserved_labels_revision: 1,
  reserved_labels_hash: one,
  availability: {
    kind: "length_band_v1",
    min_label_length: 8,
    max_label_length: 32,
  },
};
const exactScope: HandleLabelScopeV2 = {
  kind: "exact_label_v2",
  label_grammar_id: "hns_ascii_ldh_1_63_v1",
  reserved_labels_id: "reserved_labels_01",
  reserved_labels_revision: 1,
  reserved_labels_hash: one,
  handle_label: "ash",
};
const pricing = {
  kind: "free_v1",
  pricing_id: "platform_free_handles_v1",
  pricing_revision: 1,
  pricing_hash: pricingHash,
  atomic_amount: "0",
} as const;
const curated = {
  kind: "curated_policy_v1",
  policy_id: "qualification_policy_01",
  policy_revision: 7,
  policy_hash: two,
  provider_binding_hash: three,
} as const;

describe("handle sales immutable hash vectors", () => {
  test("reproduces all eight historical 5.1 vectors", () => {
    expect(handleFreePricingRevisionHash(pricing)).toEqual({
      bytes: 76,
      preimage: '["pirate-handle-free-pricing-v1","platform_free_handles_v1",1,"free_v1","0"]',
      sha256: pricingHash,
    });

    expect(
      handleOfferingRevisionV1Hash({
        offering_id: "offering_free_01",
        offering_revision: 1,
        community_id: "community_pokemon",
        family: "hns",
        namespace_root: "charizard",
        sale_namespace_activation_id: "sale_namespace_activation_01",
        sale_namespace_activation_generation: 3,
        label_scope_preimage: [
          "label_rule_v1",
          "hns_ascii_ldh_3_32_v1",
          "reserved_labels_01",
          1,
          one,
        ],
        qualification_policy: curated,
        pricing,
        issuance_driver_id: "driver_01",
        issuance_driver_version: "1",
        quote_ttl_seconds: 120,
        reservation_ttl_seconds: 300,
      }),
    ).toEqual({
      bytes: 592,
      preimage: `["pirate-handle-offering-revision-v1","offering_free_01",1,"community_pokemon","hns","charizard",["sale_namespace_activation_01",3],["label_rule_v1","hns_ascii_ldh_3_32_v1","reserved_labels_01",1,"${one}"],["curated_policy_v1","qualification_policy_01",7,"${two}","${three}"],["free_v1","platform_free_handles_v1",1,"${pricingHash}","0"],["hns","driver_01","1"],120,300]`,
      sha256: "970926b67b1791a5dd3aa334ebb1d9d1d2b1f3b3430e01975a73053e311094d9",
    });

    const identity = handlePersonaPublicIdentityHash({
      persona_id: "persona_public_01",
      public_linkage_generation: 4,
    });
    expect(identity).toEqual({
      bytes: 66,
      preimage: '["pirate-handle-persona-public-identity-v1","persona_public_01",4]',
      sha256: "f713055cfd0b05566cc0db3dde0f18a4009011c48bd427e1d84ef6fe8f3e95da",
    });
    expect(
      handlePersonaLinkConfirmationRequestHash({
        actor_account_id: "account_private_01",
        persona_id: "persona_public_01",
        offering_id: "offering_free_01",
        target_community_id: "community_pokemon",
        family: "hns",
        namespace_root: "charizard",
        persona_public_identity_digest: identity.sha256,
        idempotency_key: "link-key-01",
      }),
    ).toEqual({
      bytes: 267,
      preimage: `["pirate-handle-persona-link-confirmation-v1","/handle-persona-link-confirmations","account_private_01","persona_public_01","offering_free_01","community_pokemon","hns","charizard","${identity.sha256}",true,"link-key-01"]`,
      sha256: "f366b0f8452786af7feef6ce59865a3012bc834e549e07f75654a21de005fefc",
    });
    const quoteRequest = handleQuoteRequestHash({
      actor_account_id: "account_private_01",
      persona_id: "persona_public_01",
      offering_id: "offering_free_01",
      desired_label: "name",
      idempotency_key: "quote-key-01",
    });
    expect(quoteRequest).toEqual({
      bytes: 133,
      preimage:
        '["pirate-handle-quote-request-v1","/handle-quotes","account_private_01","persona_public_01","offering_free_01","name","quote-key-01"]',
      sha256: "3ea053ad0f074718578f5e3c0128e28e05e2e5fafec80208260a7cdd44937fc2",
    });
    const reservationRequest = handleReservationRequestHash({
      actor_account_id: "account_private_01",
      persona_id: "persona_public_01",
      quote_id: "quote_01",
      expected_quote_hash: quoteRequest.sha256,
      idempotency_key: "reserve-key-01",
    });
    expect(reservationRequest).toEqual({
      bytes: 199,
      preimage: `["pirate-handle-reservation-request-v1","/handle-reservations","account_private_01","persona_public_01","quote_01","${quoteRequest.sha256}","reserve-key-01"]`,
      sha256: "073d425d12fe301d0f06aacd81e5eb26429e8b21215ce49a4df9e007df2f10e7",
    });
    const claimRequest = handleClaimRequestHash({
      actor_account_id: "account_private_01",
      persona_id: "persona_public_01",
      reservation_id: "reservation_01",
      expected_reservation_hash: reservationRequest.sha256,
      idempotency_key: "claim-key-01",
    });
    expect(claimRequest).toEqual({
      bytes: 191,
      preimage: `["pirate-handle-claim-request-v1","/handle-claims","account_private_01","persona_public_01","reservation_01","${reservationRequest.sha256}","claim-key-01"]`,
      sha256: "57d7f98b9866efd249ad279c27cfba8467eeb24b4ccff3b38329bc0d6fff1200",
    });
    expect(
      handleGrantFinalizeV1Hash({
        claim_id: "claim_01",
        reservation_id: "reservation_01",
        family: "hns",
        namespace_root: "charizard",
        handle_label: "name",
        owner_persona_id: "persona_public_01",
        issuance_operation_id: "issuance:hns:01",
        claim_request_hash: claimRequest.sha256,
      }),
    ).toEqual({
      bytes: 193,
      preimage: `["pirate-handle-grant-finalize-v1","claim_01","reservation_01","hns","charizard","name","persona_public_01","issuance:hns:01","${claimRequest.sha256}"]`,
      sha256: "a1b07312865a50affd155def287db7f8c083da491d710227ec246d2dfbe746c8",
    });
  });

  test("reproduces all nine 5.3 successor vectors", () => {
    const binding = handleAccountDirectoryBindingHash({ binding_version: "1" });
    expect(binding).toEqual({
      bytes: 73,
      preimage: '["pirate-handle-account-directory-binding-v1","account_directory_v1","1"]',
      sha256: "c81ff980a56025b99dcd24d27979a302ca28f162ca7238dda354686082496d3d",
    });
    expect(
      handleAccountAllowlistPolicyRequestV1Hash({
        actor_account_id: "account_private_seller_01",
        community_id: "community_pokemon",
        subject_account_id: "account_private_approved_01",
        expected_account_directory_binding_version: "1",
        idempotency_key: "policy-key-01",
      }),
    ).toEqual({
      bytes: 232,
      preimage:
        '["pirate-handle-account-allowlist-policy-request-v1","/communities/:communityId/handle-qualification-policies","account_private_seller_01","community_pokemon","account_private_approved_01","account_directory_v1","1","policy-key-01"]',
      sha256: "ce85c216f326ba4b36e61ce0fa1ba84d6790939f9c639f003f26701fe7727faf",
    });
    const policy = handleAccountAllowlistPolicyHash({
      policy_id: "qualification_policy_direct_01",
      policy_revision: 1,
      requirement_id: "requirement_allowlist_01",
      requirement_revision: 1,
      subject_account_id: "account_private_approved_01",
      binding_version: "1",
      binding_hash: binding.sha256,
    });
    expect(policy).toEqual({
      bytes: 260,
      preimage: `["pirate-handle-account-allowlist-policy-v1","qualification_policy_direct_01",1,["account_allowlist_v1","requirement_allowlist_01",1,"account_private_approved_01"],["account_directory_v1","1","${binding.sha256}"]]`,
      sha256: "7d635f320433ace0ac9fb2d52e14c9c528cb47e648bfebf9f76aba69c280b3fb",
    });
    expect(
      handleDirectGrantQualificationHash({
        policy_id: "qualification_policy_direct_01",
        policy_revision: 1,
        policy_hash: policy.sha256,
        provider_binding_hash: binding.sha256,
      }),
    ).toEqual({
      bytes: 190,
      preimage: `["curated_policy_v1","qualification_policy_direct_01",1,"${policy.sha256}","${binding.sha256}"]`,
      sha256: "5eec19f2c5b969d135b7b5f6a83e63b92ee61b15788a06ebc2d24341329f5825",
    });
    expect(
      handleSaleNamespaceActivationHash({
        sale_namespace_activation_id: "sale_namespace_activation_01",
        sale_namespace_activation_generation: 3,
        community_id: "community_pokemon",
        family: "hns",
        canonical_root: "charizard",
        namespace_authority_reference: "namespace_authority_01",
        namespace_authority_generation: 7,
        dns_zone_activation_id: "dns_zone_activation_01",
        dns_zone_activation_generation: 5,
      }),
    ).toEqual({
      bytes: 263,
      preimage:
        '["pirate-handle-sale-namespace-activation-v1","sale_namespace_activation_01",3,"community_pokemon","hns","charizard",["verified_namespace_v1","namespace_authority_01",7],["hns_dns_zone_activation_v1","dns_zone_activation_01",5],["dedicated_root_replace_v1",true]]',
      sha256: "ddd8a9fa93d9ab8d3f7df370de7f86baa3094d4a337ebe306d4a09c1a8d6e0d0",
    });
    expect(
      handleOfferingRevisionV2Hash({
        offering_id: "offering_free_02",
        offering_revision: 1,
        community_id: "community_pokemon",
        family: "hns",
        namespace_root: "charizard",
        sale_namespace_activation_id: "sale_namespace_activation_01",
        sale_namespace_activation_generation: 3,
        label_scope: broadScope,
        allocation_kind: "first_come_v1",
        max_active_grants_per_account: 1,
        fulfillment_kind: "hosted_persona_v1",
        qualification_policy: curated,
        pricing,
        issuance_driver_id: "hosted_persona-local",
        issuance_driver_version: "1",
        quote_ttl_seconds: 120,
        reservation_ttl_seconds: 300,
      }),
    ).toEqual({
      bytes: 688,
      preimage: `["pirate-handle-offering-revision-v2","offering_free_02",1,"community_pokemon","hns","charizard",["sale_namespace_activation_01",3],["label_rule_v2","hns_ascii_ldh_1_63_v1","reserved_labels_01",1,"${one}",["length_band_v1",8,32]],["first_come_v1"],["account_cap_v1",1],["hosted_persona_v1"],["curated_policy_v1","qualification_policy_01",7,"${two}","${three}"],["free_v1","platform_free_handles_v1",1,"${pricingHash}","0"],["hns","hosted_persona-local","1"],120,300]`,
      sha256: offeringV2Hash,
    });
    expect(
      handleQuoteV2Hash({
        quote_id: "quote_01",
        offering_id: "offering_free_02",
        offering_revision: 1,
        offering_hash: offeringV2Hash,
        sale_namespace_activation_id: "sale_namespace_activation_01",
        sale_namespace_activation_generation: 3,
        fulfillment_kind: "hosted_persona_v1",
        owner_persona_id: "persona_public_01",
        family: "hns",
        namespace_root: "charizard",
        handle_label: "longname",
        pricing,
        eligibility: {
          decision: "passed",
          policy_revision: 7,
          policy_hash: two,
          evidence_use_ids: ["evidence_use_01"],
          evaluated_at: "2026-08-25T16:00:00.000Z",
        },
        quoted_at: "2026-08-25T16:00:00.000Z",
        expires_at: "2026-08-25T16:02:00.000Z",
      }),
    ).toEqual({
      bytes: 526,
      preimage: `["pirate-handle-quote-v2","quote_01","offering_free_02",1,"${offeringV2Hash}",["sale_namespace_activation_01",3],["hosted_persona_v1"],"persona_public_01",["hns","charizard","longname"],["free_v1","platform_free_handles_v1",1,"${pricingHash}","0"],["passed",7,"${two}",["evidence_use_01"],"2026-08-25T16:00:00.000Z"],"2026-08-25T16:00:00.000Z","2026-08-25T16:02:00.000Z"]`,
      sha256: quoteV2Hash,
    });
    expect(
      handleReservationV2Hash({
        reservation_id: "reservation_01",
        quote_id: "quote_01",
        quote_hash: quoteV2Hash,
        offering_id: "offering_free_02",
        offering_hash: offeringV2Hash,
        sale_namespace_activation_id: "sale_namespace_activation_01",
        sale_namespace_activation_generation: 3,
        fulfillment_kind: "hosted_persona_v1",
        owner_persona_id: "persona_public_01",
        family: "hns",
        namespace_root: "charizard",
        handle_label: "longname",
        reserved_at: "2026-08-25T16:00:30.000Z",
        expires_at: "2026-08-25T16:05:30.000Z",
      }),
    ).toEqual({
      bytes: 375,
      preimage: `["pirate-handle-reservation-v2","reservation_01","quote_01","${quoteV2Hash}","offering_free_02","${offeringV2Hash}",["sale_namespace_activation_01",3],["hosted_persona_v1"],"persona_public_01",["hns","charizard","longname"],"2026-08-25T16:00:30.000Z","2026-08-25T16:05:30.000Z"]`,
      sha256: reservationV2Hash,
    });
    expect(
      handleGrantFinalizeV2Hash({
        claim_id: "claim_01",
        reservation_id: "reservation_01",
        reservation_hash: reservationV2Hash,
        offering_id: "offering_free_02",
        offering_hash: offeringV2Hash,
        sale_namespace_activation_id: "sale_namespace_activation_01",
        sale_namespace_activation_generation: 3,
        fulfillment_kind: "hosted_persona_v1",
        family: "hns",
        namespace_root: "charizard",
        handle_label: "longname",
        owner_persona_id: "persona_public_01",
        issuance_operation_id: "issuance:hns-hosted:01",
        claim_request_hash: four,
      }),
    ).toEqual({
      bytes: 416,
      preimage: `["pirate-handle-grant-finalize-v2","claim_01","reservation_01","${reservationV2Hash}","offering_free_02","${offeringV2Hash}",["sale_namespace_activation_01",3],["hosted_persona_v1"],["hns","charizard","longname"],"persona_public_01","issuance:hns-hosted:01","${four}"]`,
      sha256: "e0a3b58617da518853446cbbfae6893971b99763c83ec89367065528c21037f1",
    });
  });

  test("reproduces the two recipient-token successor vectors", () => {
    expect(
      handleDirectGrantRecipientTokenRequestHash({
        actor_account_id: "account_private_approved_01",
        community_id: "community_pokemon",
        idempotency_key: "token-key-01",
      }),
    ).toEqual({
      bytes: 187,
      preimage:
        '["pirate-handle-direct-grant-recipient-token-request-v1","/communities/:communityId/handle-direct-grant-recipient-tokens","account_private_approved_01","community_pokemon","token-key-01"]',
      sha256: "5e27b57afb505751dd57a119c93d5518df23e5fb14242d8d8ef33f35595a962f",
    });
    expect(
      handleAccountAllowlistPolicyRequestV2Hash({
        actor_account_id: "account_private_seller_01",
        community_id: "community_pokemon",
        resolved_subject_account_id: "account_private_approved_01",
        expected_account_directory_binding_version: "1",
        idempotency_key: "policy-key-01",
      }),
    ).toEqual({
      bytes: 232,
      preimage:
        '["pirate-handle-account-allowlist-policy-request-v2","/communities/:communityId/handle-qualification-policies","account_private_seller_01","community_pokemon","account_private_approved_01","account_directory_v1","1","policy-key-01"]',
      sha256: "7ff2f0b71abc0bf1513b2be8f8eb9ad5f2f46d8e79285a64821f2f9c0df7c49b",
    });
  });
});

describe("handle sales policy", () => {
  test("keeps grammar wide while enforcing conservative broad availability", () => {
    expect(() => assertCanonicalHnsHandleLabelV2("a")).not.toThrow();
    expect(() => assertCanonicalHnsHandleLabelV2("a".repeat(63))).not.toThrow();
    for (const invalid of ["", "A", "name.root", "xn--name", "-name", "name-", "a".repeat(64)]) {
      expect(() => assertCanonicalHnsHandleLabelV2(invalid)).toThrow("invalid_handle");
    }
    expect(() =>
      assertHandleOfferingCombinationV2({
        label_scope: broadScope,
        allocation_kind: "first_come_v1",
        fulfillment_kind: "hosted_persona_v1",
        qualification_kind: "none_v1",
        pricing_kind: "free_v1",
        atomic_amount: "0",
      }),
    ).not.toThrow();
    expect(() =>
      assertHandleOfferingCombinationV2({
        label_scope: exactScope,
        allocation_kind: "direct_grant_v1",
        fulfillment_kind: "hosted_persona_v1",
        qualification_kind: "curated_policy_v1",
        pricing_kind: "free_v1",
        atomic_amount: "0",
      }),
    ).not.toThrow();
    expect(() =>
      assertHandleOfferingCombinationV2({
        label_scope: broadScope,
        allocation_kind: "auction_v1",
        fulfillment_kind: "hosted_persona_v1",
        qualification_kind: "none_v1",
        pricing_kind: "free_v1",
        atomic_amount: "0",
      }),
    ).toThrow();
  });

  test("classifies reserved, exact, broad, and fallthrough in order", () => {
    const offerings = [
      { offering_id: "exact", label_scope: exactScope },
      { offering_id: "broad", label_scope: broadScope },
    ] as const;
    expect(
      classifyEffectiveHandleOfferingV2({
        label: "admin",
        platform_reserved_labels: new Set(["admin"]),
        namespace_reserved_labels: new Set(),
        active_offerings: offerings,
      }),
    ).toEqual({ kind: "handle_unavailable" });
    expect(
      classifyEffectiveHandleOfferingV2({
        label: "ash",
        platform_reserved_labels: new Set(),
        namespace_reserved_labels: new Set(),
        active_offerings: offerings,
      }),
    ).toMatchObject({ kind: "offered", offering: { offering_id: "exact" } });
    const broad = classifyEffectiveHandleOfferingV2({
      label: "longname",
      platform_reserved_labels: new Set(),
      namespace_reserved_labels: new Set(),
      active_offerings: offerings,
    });
    expect(broad).toMatchObject({ kind: "offered", offering: { offering_id: "broad" } });
    expect(() =>
      assertRequestedOfferingIsEffectiveV2({
        requested_offering_id: "exact",
        classification: broad,
      }),
    ).toThrow("offering_not_applicable");
    expect(
      classifyEffectiveHandleOfferingV2({
        label: "short",
        platform_reserved_labels: new Set(),
        namespace_reserved_labels: new Set(),
        active_offerings: offerings,
      }),
    ).toEqual({ kind: "not_offered" });
  });

  test("resolves account caps and keeps revoked activation terminal", () => {
    expect(
      resolvedHandleAccountCap({
        label_scope_kind: "label_rule_v2",
        allocation_kind: "first_come_v1",
      }),
    ).toBe(1);
    expect(
      resolvedHandleAccountCap({
        label_scope_kind: "label_rule_v2",
        allocation_kind: "first_come_v1",
        requested_cap: null,
      }),
    ).toBeNull();
    expect(
      resolvedHandleAccountCap({
        label_scope_kind: "exact_label_v2",
        allocation_kind: "direct_grant_v1",
      }),
    ).toBeNull();
    expect(transitionHandleSaleActivationV1("active", "suspended")).toBe("suspended");
    expect(transitionHandleSaleActivationV1("suspended", "active")).toBe("active");
    expect(() => transitionHandleSaleActivationV1("revoked", "active")).toThrow();
  });
});
