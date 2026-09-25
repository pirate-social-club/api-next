import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { HandleClaimV2, HandleQuoteV2, SaleNamespaceActivationV1 } from "./handle-sales.ts";
import {
  CreateHandleSpacesQuoteResultV1,
  CreateSpacesSaleNamespaceActivationV1,
  HandleSpacesClaimV1,
  HandleSpacesQuoteV1,
  HandleSpacesReservationV1,
  SpacesOperatorFundingV1,
  SpacesSaleNamespaceActivationV1,
  SpacesSaleReadinessV1,
} from "./handle-sales-spaces.ts";
import { handleSalesSpacesRegistry } from "./handle-sales-spaces-endpoints.ts";

const strict = { onExcessProperty: "error" } as const;
const decodes = <S extends Schema.Top>(schema: S, value: unknown): boolean =>
  Schema.decodeUnknownExit(schema as never, strict)(value)._tag === "Success";

const activation = {
  sale_namespace_activation_id: "sale_namespace_activation_spaces_01",
  sale_namespace_activation_generation: 2,
  sale_namespace_activation_hash:
    "2761169b22e87add8e693156c2619bf5ad464a0641afcbd6cc237726d752db1b",
  community_id: "community_pokemon",
  family: "spaces",
  network: "mainnet",
  canonical_root: "charizard",
  display_root: "charizard",
  namespace_authority: {
    kind: "verified_namespace_v1",
    namespace_authority_reference: "namespace_authority_spaces_01",
    namespace_authority_generation: 4,
  },
  operator: {
    kind: "spaces_operator_assignment_v1",
    operator_assignment_id: "spaces_operator_assignment_01",
    operator_assignment_generation: 1,
  },
  operator_funding_terms: { kind: "spaces_operator_funding_confirm_v1", confirmed: true },
  status: "active",
  created_at: "2026-09-23T16:00:00.000Z",
  activated_at: "2026-09-23T16:00:00.000Z",
  suspended_at: null,
  revoked_at: null,
} as const;

describe("Spaces sale-namespace activation contract", () => {
  test("admits the checked Spaces shape and never cross-decodes with HNS", () => {
    expect(decodes(SpacesSaleNamespaceActivationV1, activation)).toBe(true);
    expect(
      decodes(handleSalesSpacesRegistry.ListHandleSaleNamespaces.response, {
        items: [activation],
        next_cursor: null,
      }),
    ).toBe(true);
    expect(decodes(SaleNamespaceActivationV1, activation)).toBe(false);
    for (const invalid of [
      { ...activation, family: "hns" },
      { ...activation, network: "signet" },
      { ...activation, canonical_root: "Charizard" },
      {
        ...activation,
        operator_funding_terms: { ...activation.operator_funding_terms, confirmed: false },
      },
      {
        ...activation,
        serving: {
          kind: "hns_dns_zone_activation_v1",
          dns_zone_activation_id: "dns",
          dns_zone_activation_generation: 1,
        },
      },
      { ...activation, root_replacement: { kind: "dedicated_root_replace_v1", confirmed: true } },
      { ...activation, delegation_address: "bcrt1pdelegation" },
    ]) {
      expect(decodes(SpacesSaleNamespaceActivationV1, invalid), JSON.stringify(invalid)).toBe(
        false,
      );
    }
  });

  test("decodes only the Spaces command and never a server-resolved fact", () => {
    const command = {
      idempotency_key: "spaces-create-1",
      family: "spaces",
      namespace_authority_reference: "namespace_authority_spaces_01",
      expected_namespace_authority_generation: 4,
      operator_assignment_id: "spaces_operator_assignment_01",
      expected_operator_assignment_generation: 1,
      operator_funding_terms_confirmed: true,
    };
    expect(decodes(CreateSpacesSaleNamespaceActivationV1, command)).toBe(true);
    for (const invalid of [
      { ...command, family: "hns" },
      { ...command, operator_funding_terms_confirmed: false },
      { ...command, canonical_root: "charizard" },
      { ...command, network: "mainnet" },
      { ...command, dns_zone_activation_id: "dns" },
      { ...command, dedicated_root_replacement_confirmed: true },
    ]) {
      expect(decodes(CreateSpacesSaleNamespaceActivationV1, invalid), JSON.stringify(invalid)).toBe(
        false,
      );
    }
  });

  test("exposes one readiness reason and no wallet fact in the funding projection", () => {
    expect(decodes(SpacesSaleReadinessV1, { kind: "ready_v1" })).toBe(true);
    expect(
      decodes(SpacesSaleReadinessV1, { kind: "not_ready_v1", reason: "driver_disabled" }),
    ).toBe(true);
    expect(decodes(SpacesSaleReadinessV1, { kind: "not_ready_v1", reason: "funding" })).toBe(false);
    const funding = {
      status: "commits_paused_insufficient_funds_v1",
      confirmed_balance_sats: "11999",
      top_up_address: null,
      observed_at: "2026-09-23T16:00:00.000Z",
    };
    expect(decodes(SpacesOperatorFundingV1, funding)).toBe(true);
    expect(decodes(SpacesOperatorFundingV1, { ...funding, confirmed_balance_sats: "-1" })).toBe(
      false,
    );
    expect(decodes(SpacesOperatorFundingV1, { ...funding, wallet_reference: "wallet" })).toBe(
      false,
    );
  });
});

/** The ratified quote_v3 vector members (spec 012 §5.3.13.6), as the owner sees them. */
const recipient = {
  kind: "persona_taproot_v1",
  network: "mainnet",
  script_pubkey_hex: "512050929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0",
} as const;
const quote = {
  quote_id: "quote_spaces_01",
  quote_hash: "7b07f6abd5ddbc68e09349189083cb867be12bc8dfcf29cf911970cacc5e65a6",
  offering_id: "offering_spaces_free_01",
  offering_revision: 1,
  offering_hash: "6e65d5999e7a5143e3d440375aeaffd9f2f98a3f4fbc317033925e5850f47051",
  sale_namespace_activation_id: "sale_namespace_activation_spaces_01",
  sale_namespace_activation_generation: 2,
  fulfillment: { kind: "spaces_native_v1" },
  owner_persona_id: "persona_public_01",
  recipient,
  handle: { family: "spaces", namespace_root: "charizard", handle_label: "longname" },
  display_identifier: "longname@charizard",
  pricing: {
    kind: "free_v1",
    pricing_id: "platform_free_handles_v1",
    pricing_revision: 1,
    pricing_hash: "cb24f410dbe3ea268df0ea438d56c48dc060f2319794ab2913717585b74809f8",
    atomic_amount: "0",
  },
  eligibility: {
    policy_revision: 1,
    policy_hash: "f834457fe6eef0f6c4762d043d976c3662baa87281e3c13864e79c969cd06482",
    decision: "passed",
    evidence_use_ids: [],
    evaluated_at: "2026-09-23T16:00:00.000Z",
  },
  status: "quoted",
  quoted_at: "2026-09-23T16:00:00.000Z",
  expires_at: "2026-09-23T16:02:00.000Z",
} as const;

describe("Spaces quote, reservation, and claim contracts", () => {
  test("keeps the Spaces label grammar when decoding owner offering terms", () => {
    const terms = {
      sale_namespace_activation_id: activation.sale_namespace_activation_id,
      expected_sale_namespace_activation_generation: 2,
      label_scope: {
        kind: "label_rule_v2",
        label_grammar_id: "spaces_subspace_label_v1",
        reserved_labels_id: "reserved_labels_spaces_01",
        expected_reserved_labels_revision: 1,
        availability: {
          kind: "length_band_v1",
          min_label_length: 8,
          max_label_length: 32,
        },
      },
      allocation_kind: "first_come_v1",
      max_active_grants_per_account: 1,
      fulfillment_kind: "spaces_native_v1",
      qualification_policy_id: "qualification_policy_spaces_members_01",
      expected_qualification_policy_revision: 1,
      pricing_id: "platform_free_handles_v1",
      expected_pricing_revision: 1,
      issuance_driver_id: "spaces_native-local",
      expected_issuance_driver_version: "1",
      quote_ttl_seconds: 120,
      reservation_ttl_seconds: 300,
    } as const;
    const parsed = Schema.decodeUnknownSync(
      handleSalesSpacesRegistry.CreateCommunityHandleOffering.request.body,
    )({ idempotency_key: "spaces-offering-http", terms });
    expect(parsed.terms).toEqual(terms);
  });

  test("carries the owner-only recipient and never cross-decodes with the HNS quote", () => {
    expect(decodes(HandleSpacesQuoteV1, quote)).toBe(true);
    expect(
      decodes(handleSalesSpacesRegistry.CreateHandleQuote.response, {
        kind: "quoted",
        quote,
        replayed: false,
      }),
    ).toBe(true);
    expect(decodes(HandleQuoteV2, quote)).toBe(false);
    for (const invalid of [
      { ...quote, recipient: { ...recipient, taproot_assignment_id: "taproot_assignment_01" } },
      { ...quote, recipient: { ...recipient, script_pubkey_hex: `0014${"a".repeat(40)}` } },
      { ...quote, recipient: { ...recipient, network: "signet" } },
      { ...quote, fulfillment: { kind: "hosted_persona_v1" } },
      { ...quote, handle: { ...quote.handle, family: "hns" } },
      { ...quote, handle: { ...quote.handle, handle_label: "xn--longname" } },
      { ...quote, handle: { ...quote.handle, handle_label: "a".repeat(63) } },
      { ...quote, handle: { ...quote.handle, handle_label: "Longname" } },
    ]) {
      expect(decodes(HandleSpacesQuoteV1, invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  test("decodes the Spaces reservation and a private pending claim with a derived delay", () => {
    const reservation = {
      reservation_id: "reservation_spaces_01",
      reservation_hash: "1d05880ef120befd4df1978c4cd5d3506ff4feb2ff419e58ecfe3b169051a1a5",
      quote_id: quote.quote_id,
      quote_hash: quote.quote_hash,
      offering_id: quote.offering_id,
      offering_hash: quote.offering_hash,
      sale_namespace_activation_id: quote.sale_namespace_activation_id,
      sale_namespace_activation_generation: 2,
      fulfillment: { kind: "spaces_native_v1" },
      owner_persona_id: quote.owner_persona_id,
      recipient,
      handle: quote.handle,
      status: "consumed",
      reserved_at: "2026-09-23T16:00:30.000Z",
      expires_at: "2026-09-23T16:05:30.000Z",
    } as const;
    expect(decodes(HandleSpacesReservationV1, reservation)).toBe(true);
    const claim = {
      claim_id: "claim_spaces_01",
      owner_persona_id: quote.owner_persona_id,
      offering_id: quote.offering_id,
      offering_hash: quote.offering_hash,
      quote_id: quote.quote_id,
      reservation_id: reservation.reservation_id,
      reservation_hash: reservation.reservation_hash,
      sale_namespace_activation_id: quote.sale_namespace_activation_id,
      sale_namespace_activation_generation: 2,
      fulfillment: { kind: "spaces_native_v1" },
      recipient,
      handle: quote.handle,
      display_identifier: quote.display_identifier,
      payment: {
        kind: "not_required_v1",
        pricing_revision: 1,
        pricing_hash: quote.pricing.pricing_hash,
        atomic_amount: "0",
        status: "not_applicable",
      },
      state: "issuance_pending",
      delayed: true,
      safe_reason: "issuance_pending",
      grant: null,
      created_at: "2026-09-23T16:01:00.000Z",
      updated_at: "2026-09-23T16:01:00.000Z",
    } as const;
    expect(decodes(HandleSpacesClaimV1, claim)).toBe(true);
    expect(
      decodes(handleSalesSpacesRegistry.SubmitFreeHandleClaim.response, {
        claim,
        replayed: false,
      }),
    ).toBe(true);
    expect(decodes(handleSalesSpacesRegistry.GetHandleClaim.response, claim)).toBe(true);
    expect(
      decodes(HandleSpacesClaimV1, { ...claim, safe_reason: "recipient_wallet_required" }),
    ).toBe(true);
    expect(decodes(HandleClaimV2, claim)).toBe(false);
    for (const invalid of [
      { ...claim, state: "blocked" },
      { ...claim, delayed: undefined },
      { ...claim, safe_reason: "commits_paused" },
      { ...claim, recipient: { ...recipient, taproot_assignment_id: "taproot_assignment_01" } },
    ]) {
      expect(decodes(HandleSpacesClaimV1, invalid), JSON.stringify(invalid)).toBe(false);
    }
  });

  test("keeps the Spaces public route exact and separate from the HNS root", () => {
    const path = handleSalesSpacesRegistry.GetPublicHandleGrant.request.path;
    expect(
      decodes(path, {
        family: "hns",
        namespaceRoot: "charizard",
        handleLabel: "longname",
      }),
    ).toBe(true);
    expect(
      decodes(path, {
        family: "spaces",
        namespaceRoot: "xn--6r8h",
        handleLabel: "longname",
      }),
    ).toBe(true);
    expect(
      decodes(path, {
        family: "spaces",
        namespaceRoot: "XN--6R8H",
        handleLabel: "longname",
      }),
    ).toBe(false);
    expect(
      decodes(path, {
        family: "spaces",
        namespaceRoot: "xn--6r8h",
        handleLabel: "xn--longname",
      }),
    ).toBe(false);
  });

  test("refuses a quote without a recipient wallet or membership before any quote exists", () => {
    const base = { offering_id: quote.offering_id, owner_persona_id: quote.owner_persona_id };
    expect(
      decodes(CreateHandleSpacesQuoteResultV1, {
        kind: "recipient_wallet_required",
        ...base,
        reason: "recipient_wallet_required",
      }),
    ).toBe(true);
    expect(
      decodes(CreateHandleSpacesQuoteResultV1, {
        kind: "eligibility_required",
        ...base,
        reason: "qualification_unsatisfied",
      }),
    ).toBe(true);
    for (const invalid of [
      { kind: "eligibility_required", ...base, reason: "evidence_required" },
      {
        kind: "recipient_wallet_required",
        ...base,
        reason: "recipient_wallet_required",
        address: "bc1p",
      },
      {
        kind: "nationality_required",
        ...base,
        qualification_intent_id: "intent",
        reason: "evidence_required",
      },
    ]) {
      expect(decodes(CreateHandleSpacesQuoteResultV1, invalid), JSON.stringify(invalid)).toBe(
        false,
      );
    }
    expect(
      decodes(CreateHandleSpacesQuoteResultV1, { kind: "quoted", quote, replayed: false }),
    ).toBe(true);
  });
});
