import { describe, expect, test } from "bun:test";
import {
  type HandleLabelScopeV2,
  handleGrantFinalizeV2Hash,
  handleOfferingRevisionV2Hash,
  handleOfferingRevisionV3Hash,
  handleQuoteV2Hash,
  handleQuoteV3Hash,
  handleReservationV2Hash,
  isCanonicalHnsHandleLabelV2,
} from "./sales-v2.ts";
import {
  classifySpacesSuccessorPreimageV1,
  handleIssuanceOperationIdV1,
  handleSpacesGrantFinalizeV3Hash,
  handleSpacesQuoteV3Hash,
  handleSpacesReservationV3Hash,
  handleSpacesSaleNamespaceActivationHash,
  isP2trOutputScriptHexV1,
  type SpacesRecipientBindingV1,
  spacesRecipientPreimageV1,
} from "./spaces-native.ts";
import {
  assertSpacesOfferingCombinationV1,
  compileSpacesMembershipQualificationV1,
  handleSpacesMembershipPolicyHash,
  handleSpacesMembershipSourceHash,
} from "./spaces-native-membership.ts";
import {
  isCanonicalSpacesSubspaceLabelV1,
  parseSpacesHandleV1,
  renderSpacesHandleV1,
} from "./spaces-native-names.ts";

// Spec 012 §5.3.13.6 launch vectors, copied from the ratified block.
const ACTIVATION = {
  bytes: 316,
  preimage:
    '["pirate-handle-spaces-sale-namespace-activation-v1","sale_namespace_activation_spaces_01",2,"community_pokemon","spaces","charizard","mainnet",["verified_namespace_v1","namespace_authority_spaces_01",4],["spaces_operator_assignment_v1","spaces_operator_assignment_01",1],["spaces_operator_funding_confirm_v1",true]]',
  sha256: "2761169b22e87add8e693156c2619bf5ad464a0641afcbd6cc237726d752db1b",
};
const MEMBERSHIP_SOURCE = {
  bytes: 79,
  preimage: '["pirate-handle-spaces-membership-source-v1","spec-016-active-membership-v1",1]',
  sha256: "19a2a7128e859a7e7c4e93020d4543636e49d9b0035cf8455c4806b72781cd75",
};
const MEMBERSHIP_POLICY = {
  bytes: 247,
  preimage:
    '["pirate-handle-spaces-membership-policy-v1","qualification_policy_spaces_members_01",1,["community_membership_v1","requirement_spaces_membership_01",1],["membership_source_v1",1,"19a2a7128e859a7e7c4e93020d4543636e49d9b0035cf8455c4806b72781cd75"]]',
  sha256: "f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482",
};
const OFFERING = {
  bytes: 724,
  preimage:
    '["pirate-handle-offering-revision-v2","offering_spaces_free_01",1,"community_pokemon","spaces","charizard",["sale_namespace_activation_spaces_01",2],["label_rule_v2","spaces_subspace_label_v1","reserved_labels_01",1,"1111111111111111111111111111111111111111111111111111111111111111",["length_band_v1",8,32]],["first_come_v1"],["account_cap_v1",1],["spaces_native_v1"],["curated_policy_v1","qualification_policy_spaces_members_01",1,"f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482","19a2a7128e859a7e7c4e93020d4543636e49d9b0035cf8455c4806b72781cd75"],["free_v1","platform_free_handles_v1",1,"cb24f410dbe3ea268df0ea438d56c48dc060f2319794ab2913717585b74809f8","0"],["spaces","spaces_native-local","1"],120,300]',
  sha256: "6e65d5999e7a5143e3d440375aeaffd9f2f98a3f4fbc317033925e5850f47051",
};
const QUOTE = {
  bytes: 660,
  preimage:
    '["pirate-handle-quote-v3","quote_spaces_01","offering_spaces_free_01",1,"6e65d5999e7a5143e3d440375aeaffd9f2f98a3f4fbc317033925e5850f47051",["sale_namespace_activation_spaces_01",2],["spaces_native_v1"],"persona_public_01",["persona_taproot_v1","mainnet","taproot_assignment_01","512050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"],["spaces","charizard","longname"],["free_v1","platform_free_handles_v1",1,"cb24f410dbe3ea268df0ea438d56c48dc060f2319794ab2913717585b74809f8","0"],["passed",1,"f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482",[],"2026-09-23T16:00:00.000Z"],"2026-09-23T16:00:00.000Z","2026-09-23T16:02:00.000Z"]',
  sha256: "7b07f6abd5ddbc68e09349189083cb867be12bc8dfcf29cf911970cacc5e65a6",
};
const RESERVATION = {
  bytes: 533,
  preimage:
    '["pirate-handle-reservation-v3","reservation_spaces_01","quote_spaces_01","7b07f6abd5ddbc68e09349189083cb867be12bc8dfcf29cf911970cacc5e65a6","offering_spaces_free_01","6e65d5999e7a5143e3d440375aeaffd9f2f98a3f4fbc317033925e5850f47051",["sale_namespace_activation_spaces_01",2],["spaces_native_v1"],"persona_public_01",["persona_taproot_v1","mainnet","taproot_assignment_01","512050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"],["spaces","charizard","longname"],"2026-09-23T16:00:30.000Z","2026-09-23T16:05:30.000Z"]',
  sha256: "1d05880ef120befd4df1978c4cd5d3506ff4feb2ff419e58ecfe3b169051a1a5",
};
const GRANT = {
  bytes: 577,
  preimage:
    '["pirate-handle-grant-finalize-v3","claim_spaces_01","reservation_spaces_01","1d05880ef120befd4df1978c4cd5d3506ff4feb2ff419e58ecfe3b169051a1a5","offering_spaces_free_01","6e65d5999e7a5143e3d440375aeaffd9f2f98a3f4fbc317033925e5850f47051",["sale_namespace_activation_spaces_01",2],["spaces_native_v1"],["spaces","charizard","longname"],"persona_public_01",["persona_taproot_v1","mainnet","taproot_assignment_01","512050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0"],"issuance:spaces-native:01","4444444444444444444444444444444444444444444444444444444444444444"]',
  sha256: "45e665ce7ad58d3d6d756f0bf3f9032e194a7751f95d64b46b53291cc9025587",
};

/** BIP-341 NUMS x-only key; the fixture names no spendable key. */
const NUMS_SCRIPT = "512050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0";
const pricing = {
  kind: "free_v1",
  pricing_id: "platform_free_handles_v1",
  pricing_revision: 1,
  pricing_hash: "cb24f410dbe3ea268df0ea438d56c48dc060f2319794ab2913717585b74809f8",
  atomic_amount: "0",
} as const;
const recipient: SpacesRecipientBindingV1 = {
  kind: "persona_taproot_v1",
  network: "mainnet",
  taproot_assignment_id: "taproot_assignment_01",
  script_pubkey_hex: NUMS_SCRIPT,
};
const spacesScope: HandleLabelScopeV2 = {
  kind: "label_rule_v2",
  label_grammar_id: "spaces_subspace_label_v1",
  reserved_labels_id: "reserved_labels_01",
  reserved_labels_revision: 1,
  reserved_labels_hash: "1".repeat(64),
  availability: { kind: "length_band_v1", min_label_length: 8, max_label_length: 32 },
};
const membershipPolicy = {
  policy_id: "qualification_policy_spaces_members_01",
  policy_revision: 1,
  requirement_id: "requirement_spaces_membership_01",
  requirement_revision: 1,
  source_revision: 1,
} as const;

const activationInput = {
  sale_namespace_activation_id: "sale_namespace_activation_spaces_01",
  sale_namespace_activation_generation: 2,
  community_id: "community_pokemon",
  network: "mainnet",
  canonical_root: "charizard",
  namespace_authority_reference: "namespace_authority_spaces_01",
  namespace_authority_generation: 4,
  operator_assignment_id: "spaces_operator_assignment_01",
  operator_assignment_generation: 1,
  operator_funding_terms_confirmed: true,
} as const;
const offeringInput = {
  offering_id: "offering_spaces_free_01",
  offering_revision: 1,
  community_id: "community_pokemon",
  family: "spaces",
  namespace_root: "charizard",
  sale_namespace_activation_id: "sale_namespace_activation_spaces_01",
  sale_namespace_activation_generation: 2,
  label_scope: spacesScope,
  allocation_kind: "first_come_v1",
  max_active_grants_per_account: 1,
  fulfillment_kind: "spaces_native_v1",
  qualification_policy: compileSpacesMembershipQualificationV1(membershipPolicy, 1),
  pricing,
  issuance_driver_id: "spaces_native-local",
  issuance_driver_version: "1",
  quote_ttl_seconds: 120,
  reservation_ttl_seconds: 300,
} as const;
const quoteInput = {
  quote_id: "quote_spaces_01",
  offering_id: "offering_spaces_free_01",
  offering_revision: 1,
  offering_hash: OFFERING.sha256,
  sale_namespace_activation_id: "sale_namespace_activation_spaces_01",
  sale_namespace_activation_generation: 2,
  fulfillment_kind: "spaces_native_v1",
  owner_persona_id: "persona_public_01",
  recipient,
  family: "spaces",
  namespace_root: "charizard",
  handle_label: "longname",
  pricing,
  eligibility: {
    decision: "passed",
    policy_revision: 1,
    policy_hash: MEMBERSHIP_POLICY.sha256,
    evidence_use_ids: [],
    evaluated_at: "2026-09-23T16:00:00.000Z",
  },
  quoted_at: "2026-09-23T16:00:00.000Z",
  expires_at: "2026-09-23T16:02:00.000Z",
} as const;
const reservationInput = {
  reservation_id: "reservation_spaces_01",
  quote_id: "quote_spaces_01",
  quote_hash: QUOTE.sha256,
  offering_id: "offering_spaces_free_01",
  offering_hash: OFFERING.sha256,
  sale_namespace_activation_id: "sale_namespace_activation_spaces_01",
  sale_namespace_activation_generation: 2,
  fulfillment_kind: "spaces_native_v1",
  owner_persona_id: "persona_public_01",
  recipient,
  family: "spaces",
  namespace_root: "charizard",
  handle_label: "longname",
  reserved_at: "2026-09-23T16:00:30.000Z",
  expires_at: "2026-09-23T16:05:30.000Z",
} as const;
const grantInput = {
  claim_id: "claim_spaces_01",
  reservation_id: "reservation_spaces_01",
  reservation_hash: RESERVATION.sha256,
  offering_id: "offering_spaces_free_01",
  offering_hash: OFFERING.sha256,
  sale_namespace_activation_id: "sale_namespace_activation_spaces_01",
  sale_namespace_activation_generation: 2,
  fulfillment_kind: "spaces_native_v1",
  family: "spaces",
  namespace_root: "charizard",
  handle_label: "longname",
  owner_persona_id: "persona_public_01",
  recipient,
  issuance_operation_id: "issuance:spaces-native:01",
  claim_request_hash: "4".repeat(64),
} as const;

describe("Spaces launch vectors", () => {
  test("reproduce all seven ratified vectors byte for byte", () => {
    expect(handleSpacesSaleNamespaceActivationHash(activationInput)).toEqual(ACTIVATION);
    const source = handleSpacesMembershipSourceHash({ source_revision: 1 });
    expect(source).toEqual(MEMBERSHIP_SOURCE);
    expect(
      handleSpacesMembershipPolicyHash({ ...membershipPolicy, source_hash: source.sha256 }),
    ).toEqual(MEMBERSHIP_POLICY);
    expect(handleOfferingRevisionV2Hash(offeringInput)).toEqual(OFFERING);
    expect(handleSpacesQuoteV3Hash(quoteInput)).toEqual(QUOTE);
    expect(handleSpacesReservationV3Hash(reservationInput)).toEqual(RESERVATION);
    expect(handleSpacesGrantFinalizeV3Hash(grantInput)).toEqual(GRANT);
  });

  test("chain membership source to policy to the offering's curated reference", () => {
    expect(compileSpacesMembershipQualificationV1(membershipPolicy, 1)).toEqual({
      kind: "curated_policy_v1",
      policy_id: "qualification_policy_spaces_members_01",
      policy_revision: 1,
      policy_hash: MEMBERSHIP_POLICY.sha256,
      provider_binding_hash: MEMBERSHIP_SOURCE.sha256,
    });
  });

  test("binds the recipient as the four-member Taproot preimage", () => {
    expect(spacesRecipientPreimageV1(recipient)).toEqual([
      "persona_taproot_v1",
      "mainnet",
      "taproot_assignment_01",
      NUMS_SCRIPT,
    ]);
    expect(() => spacesRecipientPreimageV1({ ...recipient, script_pubkey_hex: "0014" })).toThrow(
      "Invalid P2TR output script",
    );
    expect(() => spacesRecipientPreimageV1({ ...recipient, network: "signet" as never })).toThrow(
      "Invalid Spaces network",
    );
  });
});

describe("Spaces hash mutations", () => {
  const otherScript = `5120${"ab".repeat(32)}`;
  const recipientMutations: readonly SpacesRecipientBindingV1[] = [
    { ...recipient, network: "testnet4" },
    { ...recipient, script_pubkey_hex: otherScript },
    { ...recipient, taproot_assignment_id: "taproot_assignment_02" },
  ];

  test("activation binds network, root, authority, operator assignment, and funding", () => {
    for (const mutation of [
      { network: "testnet4" },
      { canonical_root: "blastoise" },
      { community_id: "community_other" },
      { namespace_authority_reference: "namespace_authority_spaces_02" },
      { namespace_authority_generation: 5 },
      { operator_assignment_id: "spaces_operator_assignment_02" },
      { operator_assignment_generation: 2 },
      { operator_funding_terms_confirmed: false },
      { sale_namespace_activation_generation: 3 },
    ] as const) {
      expect(
        handleSpacesSaleNamespaceActivationHash({ ...activationInput, ...mutation }).sha256,
      ).not.toBe(ACTIVATION.sha256);
    }
  });

  test("membership source and policy bind every member", () => {
    const sourceTwo = handleSpacesMembershipSourceHash({ source_revision: 2 });
    expect(sourceTwo.sha256).not.toBe(MEMBERSHIP_SOURCE.sha256);
    for (const mutation of [
      { policy_id: "qualification_policy_spaces_members_02" },
      { policy_revision: 2 },
      { requirement_id: "requirement_spaces_membership_02" },
      { requirement_revision: 2 },
      { source_revision: 2, source_hash: sourceTwo.sha256 },
    ]) {
      expect(
        handleSpacesMembershipPolicyHash({
          ...membershipPolicy,
          source_hash: MEMBERSHIP_SOURCE.sha256,
          ...mutation,
        }).sha256,
      ).not.toBe(MEMBERSHIP_POLICY.sha256);
    }
    expect(() =>
      handleSpacesMembershipPolicyHash({
        ...membershipPolicy,
        source_revision: 2,
        source_hash: MEMBERSHIP_SOURCE.sha256,
      }),
    ).toThrow("Stale membership source hash");
  });

  test("recipient network, script, and assignment move quote, reservation, and grant", () => {
    for (const changed of recipientMutations) {
      expect(handleSpacesQuoteV3Hash({ ...quoteInput, recipient: changed }).sha256).not.toBe(
        QUOTE.sha256,
      );
      expect(
        handleSpacesReservationV3Hash({ ...reservationInput, recipient: changed }).sha256,
      ).not.toBe(RESERVATION.sha256);
      expect(
        handleSpacesGrantFinalizeV3Hash({ ...grantInput, recipient: changed }).sha256,
      ).not.toBe(GRANT.sha256);
    }
  });

  test("every reused version-2 member moves its version-3 hash", () => {
    const quoteMutations = [
      { quote_id: "quote_spaces_02" },
      { offering_id: "offering_spaces_free_02" },
      { offering_revision: 2 },
      { offering_hash: "a".repeat(64) },
      { sale_namespace_activation_id: "sale_namespace_activation_spaces_02" },
      { sale_namespace_activation_generation: 3 },
      { owner_persona_id: "persona_public_02" },
      { namespace_root: "blastoise" },
      { handle_label: "othername" },
      { pricing: { ...pricing, pricing_revision: 2 } },
      { eligibility: { ...quoteInput.eligibility, policy_revision: 2 } },
      { eligibility: { ...quoteInput.eligibility, evaluated_at: "2026-09-23T16:00:01.000Z" } },
      { quoted_at: "2026-09-23T16:00:01.000Z" },
      { expires_at: "2026-09-23T16:02:01.000Z" },
    ];
    for (const mutation of quoteMutations) {
      expect(handleSpacesQuoteV3Hash({ ...quoteInput, ...mutation }).sha256).not.toBe(QUOTE.sha256);
    }
    const reservationMutations = [
      { reservation_id: "reservation_spaces_02" },
      { quote_id: "quote_spaces_02" },
      { quote_hash: "a".repeat(64) },
      { offering_id: "offering_spaces_free_02" },
      { offering_hash: "a".repeat(64) },
      { sale_namespace_activation_id: "sale_namespace_activation_spaces_02" },
      { sale_namespace_activation_generation: 3 },
      { owner_persona_id: "persona_public_02" },
      { namespace_root: "blastoise" },
      { handle_label: "othername" },
      { reserved_at: "2026-09-23T16:00:31.000Z" },
      { expires_at: "2026-09-23T16:05:31.000Z" },
    ];
    for (const mutation of reservationMutations) {
      expect(handleSpacesReservationV3Hash({ ...reservationInput, ...mutation }).sha256).not.toBe(
        RESERVATION.sha256,
      );
    }
    const grantMutations = [
      { claim_id: "claim_spaces_02" },
      { reservation_id: "reservation_spaces_02" },
      { reservation_hash: "a".repeat(64) },
      { offering_id: "offering_spaces_free_02" },
      { offering_hash: "a".repeat(64) },
      { sale_namespace_activation_id: "sale_namespace_activation_spaces_02" },
      { sale_namespace_activation_generation: 3 },
      { namespace_root: "blastoise" },
      { handle_label: "othername" },
      { owner_persona_id: "persona_public_02" },
      { issuance_operation_id: "issuance:spaces-native:02" },
      { claim_request_hash: "5".repeat(64) },
    ];
    for (const mutation of grantMutations) {
      expect(handleSpacesGrantFinalizeV3Hash({ ...grantInput, ...mutation }).sha256).not.toBe(
        GRANT.sha256,
      );
    }
  });

  test("offering binds activation generation, qualification, and label scope", () => {
    for (const mutation of [
      { sale_namespace_activation_generation: 3 },
      {
        qualification_policy: compileSpacesMembershipQualificationV1(
          { ...membershipPolicy, policy_revision: 2 },
          1,
        ),
      },
      {
        label_scope: {
          ...spacesScope,
          availability: { kind: "length_band_v1", min_label_length: 9, max_label_length: 32 },
        } as const,
      },
    ]) {
      expect(handleOfferingRevisionV2Hash({ ...offeringInput, ...mutation }).sha256).not.toBe(
        OFFERING.sha256,
      );
    }
  });
});

describe("Spaces and HNS hash domains stay disjoint", () => {
  const hnsQuote = {
    ...quoteInput,
    fulfillment_kind: "hosted_persona_v1",
    family: "hns",
    eligibility: { ...quoteInput.eligibility, evidence_use_ids: ["evidence_use_01"] },
  } as const;

  test("no HNS path emits a Spaces version-3 hash", () => {
    expect(() =>
      handleSpacesQuoteV3Hash({ ...quoteInput, fulfillment_kind: "hosted_persona_v1" }),
    ).toThrow("spaces_native_v1");
    expect(() => handleSpacesQuoteV3Hash({ ...quoteInput, family: "hns" })).toThrow(
      "spaces_native_v1",
    );
    expect(() =>
      handleSpacesReservationV3Hash({ ...reservationInput, fulfillment_kind: "hosted_persona_v1" }),
    ).toThrow("spaces_native_v1");
    expect(() =>
      handleSpacesGrantFinalizeV3Hash({ ...grantInput, fulfillment_kind: "hosted_persona_v1" }),
    ).toThrow("spaces_native_v1");
    expect(() =>
      handleSpacesGrantFinalizeV3Hash({
        ...grantInput,
        issuance_operation_id: "issuance:hns-hosted:01",
      }),
    ).toThrow("Spaces issuance operation");
  });

  test("no Spaces path emits an HNS version-2 or nationality hash", () => {
    const { recipient: _recipient, ...quoteWithoutRecipient } = quoteInput;
    const { recipient: _reservationRecipient, ...reservationWithoutRecipient } = reservationInput;
    const { recipient: _grantRecipient, ...grantWithoutRecipient } = grantInput;
    expect(() => handleQuoteV2Hash(quoteWithoutRecipient)).toThrow("Spaces successor");
    expect(() => handleQuoteV2Hash({ ...quoteWithoutRecipient, family: "hns" })).toThrow(
      "Spaces successor",
    );
    expect(() =>
      handleQuoteV2Hash({ ...quoteWithoutRecipient, fulfillment_kind: "hosted_persona_v1" }),
    ).toThrow("Spaces successor");
    expect(() => handleReservationV2Hash(reservationWithoutRecipient)).toThrow("Spaces successor");
    expect(() => handleGrantFinalizeV2Hash(grantWithoutRecipient)).toThrow("Spaces successor");
    expect(() =>
      handleQuoteV3Hash({
        ...quoteWithoutRecipient,
        eligibility: { kind: "curated_policy_v1", snapshot: quoteInput.eligibility },
      }),
    ).toThrow("Spaces successor");
    expect(() =>
      handleOfferingRevisionV3Hash({
        ...offeringInput,
        qualification_policy: {
          kind: "curated_nationality_v1",
          policy_id: "nationality_policy_01",
          policy_revision: 1,
          policy_hash: "2".repeat(64),
          requirement_hash: "3".repeat(64),
          provider_binding_hashes: ["4".repeat(64), "5".repeat(64)],
          lifetime: { kind: "max_age_seconds", seconds: 31_536_000 },
        },
      }),
    ).toThrow("Spaces successor");
  });

  test("the offering revision admits each grammar and fulfillment only with its own family", () => {
    const hnsScope = { ...spacesScope, label_grammar_id: "hns_ascii_ldh_1_63_v1" } as const;
    expect(() =>
      handleOfferingRevisionV2Hash({ ...offeringInput, fulfillment_kind: "hosted_persona_v1" }),
    ).toThrow("family and fulfillment");
    expect(() =>
      handleOfferingRevisionV2Hash({ ...offeringInput, family: "hns", label_scope: hnsScope }),
    ).toThrow("family and fulfillment");
    expect(() => handleOfferingRevisionV2Hash({ ...offeringInput, label_scope: hnsScope })).toThrow(
      "Unsupported handle grammar",
    );
    expect(() =>
      handleOfferingRevisionV2Hash({
        ...offeringInput,
        family: "hns",
        fulfillment_kind: "hosted_persona_v1",
      }),
    ).toThrow("Unsupported handle grammar");
  });

  test("stored preimages decode only into their own family", () => {
    expect(classifySpacesSuccessorPreimageV1(QUOTE.preimage)).toBe("quote_v3");
    expect(classifySpacesSuccessorPreimageV1(RESERVATION.preimage)).toBe("reservation_v3");
    expect(classifySpacesSuccessorPreimageV1(GRANT.preimage)).toBe("grant_finalize_v3");
    for (const other of [ACTIVATION, MEMBERSHIP_SOURCE, MEMBERSHIP_POLICY, OFFERING]) {
      expect(classifySpacesSuccessorPreimageV1(other.preimage)).toBeNull();
    }
    const hns = {
      quote: handleQuoteV2Hash(hnsQuote),
      nationalityQuote: handleQuoteV3Hash({
        ...hnsQuote,
        eligibility: { kind: "curated_policy_v1", snapshot: hnsQuote.eligibility },
      }),
      reservation: handleReservationV2Hash({
        ...reservationInput,
        fulfillment_kind: "hosted_persona_v1",
        family: "hns",
      }),
      grant: handleGrantFinalizeV2Hash({
        ...grantInput,
        fulfillment_kind: "hosted_persona_v1",
        family: "hns",
        issuance_operation_id: "issuance:hns-hosted:01",
      }),
    };
    for (const hash of Object.values(hns)) {
      expect(classifySpacesSuccessorPreimageV1(hash.preimage)).toBeNull();
    }
    // The shared quote-v3 tag never collides: the HNS nationality quote has thirteen members.
    expect(JSON.parse(hns.nationalityQuote.preimage)[0]).toBe("pirate-handle-quote-v3");
    expect(JSON.parse(hns.nationalityQuote.preimage)).toHaveLength(13);
    expect(JSON.parse(QUOTE.preimage)).toHaveLength(14);
    expect(classifySpacesSuccessorPreimageV1(` ${QUOTE.preimage}`)).toBeNull();
    expect(classifySpacesSuccessorPreimageV1(QUOTE.preimage.replace('"spaces",', '"hns",'))).toBe(
      null,
    );
    expect(classifySpacesSuccessorPreimageV1("not json")).toBeNull();
    expect(classifySpacesSuccessorPreimageV1('["constructor"]')).toBeNull();
  });
});

describe("Spaces subordinate grammar and names", () => {
  test("freezes spaces_subspace_label_v1", () => {
    for (const valid of ["a", "0", "longname", "a1-b2-c3", "a".repeat(62)]) {
      expect(isCanonicalSpacesSubspaceLabelV1(valid), valid).toBe(true);
      expect(isCanonicalHnsHandleLabelV2(valid), valid).toBe(true);
    }
    for (const invalid of [
      "",
      "xn--abc",
      "xn--4v8h",
      "Longname",
      "LONGNAME",
      "a--b",
      "-name",
      "name-",
      "a".repeat(63),
      "long.name",
      "long#name",
      "#3438-1-0",
      "long@name",
      " longname",
      "longname ",
      "long_name",
      "münchen",
      "🔥",
    ]) {
      expect(isCanonicalSpacesSubspaceLabelV1(invalid), invalid).toBe(false);
    }
    // A strict subset of the HNS grammar: 63 bytes is HNS-only.
    expect(isCanonicalHnsHandleLabelV2("a".repeat(63))).toBe(true);
  });

  test("renders label@root and re-parses it exactly", () => {
    expect(renderSpacesHandleV1({ handle_label: "longname", namespace_root: "charizard" })).toBe(
      "longname@charizard",
    );
    expect(parseSpacesHandleV1("longname@charizard")).toEqual({
      handle_label: "longname",
      namespace_root: "charizard",
    });
    expect(parseSpacesHandleV1("alice@xn--4v8h")).toEqual({
      handle_label: "alice",
      namespace_root: "xn--4v8h",
    });
    for (const invalid of [
      "longname",
      "@charizard",
      "longname@",
      "Longname@charizard",
      "longname@Charizard",
      "longname@@charizard",
      "a@b@c",
      "long.name@charizard",
      "longname@char.izard",
      "longname@🔥",
      "longname#3438-1-0",
      "longname@#3438-1-0",
      "xn--abc@charizard",
      " longname@charizard",
      "longname@charizard ",
      "longname%40charizard",
    ]) {
      expect(parseSpacesHandleV1(invalid), invalid).toBeNull();
    }
    expect(() =>
      renderSpacesHandleV1({ handle_label: "a--b", namespace_root: "charizard" }),
    ).toThrow("invalid_handle");
    expect(() => renderSpacesHandleV1({ handle_label: "alice", namespace_root: "🔥" })).toThrow(
      "Spaces root",
    );
  });

  test("checks the exact P2TR output script", () => {
    expect(isP2trOutputScriptHexV1(NUMS_SCRIPT)).toBe(true);
    for (const invalid of [
      NUMS_SCRIPT.toUpperCase(),
      `0014${"ab".repeat(20)}`,
      `5121${"ab".repeat(32)}`,
      `5120${"ab".repeat(31)}`,
      `5120${"ab".repeat(33)}`,
      `${NUMS_SCRIPT}\n`,
    ]) {
      expect(isP2trOutputScriptHexV1(invalid), invalid).toBe(false);
    }
  });

  test("derives one issuance operation per claim and family", () => {
    expect(
      handleIssuanceOperationIdV1({ fulfillment_kind: "spaces_native_v1", claim_id: "claim_01" }),
    ).toBe("issuance:spaces-native:claim_01");
    expect(
      handleIssuanceOperationIdV1({ fulfillment_kind: "hosted_persona_v1", claim_id: "claim_01" }),
    ).toBe("issuance:hns-hosted:claim_01");
    expect(() =>
      handleIssuanceOperationIdV1({ fulfillment_kind: "delegated_zone_v1", claim_id: "claim_01" }),
    ).toThrow("reserved");
    expect(() =>
      handleIssuanceOperationIdV1({ fulfillment_kind: "spaces_native_v1", claim_id: " claim" }),
    ).toThrow();
  });
});

describe("Spaces members-only offering compiler guard", () => {
  const combination = {
    label_scope: spacesScope,
    allocation_kind: "first_come_v1",
    fulfillment_kind: "spaces_native_v1",
    qualification_policy: offeringInput.qualification_policy,
    membership_policy: membershipPolicy,
    current_membership_source_revision: 1,
    pricing_kind: "free_v1",
    atomic_amount: "0",
  } as const;

  test("admits only the free first-come members-only combination", () => {
    expect(() => assertSpacesOfferingCombinationV1(combination)).not.toThrow();
    expect(() =>
      assertSpacesOfferingCombinationV1({
        ...combination,
        qualification_policy: {
          kind: "none_v1",
          policy_id: "qualification_policy_none_01",
          policy_revision: 1,
          policy_hash: "2".repeat(64),
        },
      }),
    ).toThrow("members-only");
    expect(() =>
      assertSpacesOfferingCombinationV1({
        ...combination,
        qualification_policy: {
          ...offeringInput.qualification_policy,
          provider_binding_hash: "3".repeat(64),
        },
      }),
    ).toThrow("members-only");
    expect(() =>
      assertSpacesOfferingCombinationV1({ ...combination, current_membership_source_revision: 2 }),
    ).toThrow("Stale membership source revision");
    expect(() =>
      assertSpacesOfferingCombinationV1({
        ...combination,
        label_scope: {
          kind: "exact_label_v2",
          label_grammar_id: "spaces_subspace_label_v1",
          reserved_labels_id: "reserved_labels_01",
          reserved_labels_revision: 1,
          reserved_labels_hash: "1".repeat(64),
          handle_label: "ash",
        },
        allocation_kind: "direct_grant_v1",
      }),
    ).toThrow("Unsupported Spaces offering combination");
    expect(() =>
      assertSpacesOfferingCombinationV1({ ...combination, allocation_kind: "direct_grant_v1" }),
    ).toThrow("Unsupported Spaces offering combination");
    expect(() =>
      assertSpacesOfferingCombinationV1({ ...combination, fulfillment_kind: "hosted_persona_v1" }),
    ).toThrow("Unsupported Spaces offering combination");
    expect(() => assertSpacesOfferingCombinationV1({ ...combination, atomic_amount: "1" })).toThrow(
      "Unsupported Spaces offering combination",
    );
    expect(() =>
      assertSpacesOfferingCombinationV1({
        ...combination,
        label_scope: { ...spacesScope, label_grammar_id: "hns_ascii_ldh_1_63_v1" },
      }),
    ).toThrow("Unsupported handle grammar");
  });
});
