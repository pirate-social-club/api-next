import { describe, expect, test } from "bun:test";
import { spacesClaimFromRow, spacesQuoteFromRow } from "./spaces-handle-claims.ts";

/**
 * Family-aware decoding of native Spaces rows (spec 012 §5.3.13.6-§5.3.13.7).
 * The owner projection never carries the private Taproot assignment id, an HNS
 * row never decodes as Spaces, and `delayed` is derived from the stored facts.
 */

const script = `5120${"ab".repeat(32)}`;
const recipientColumns = {
  recipient_kind: "persona_taproot_v1",
  recipient_network: "regtest",
  recipient_taproot_assignment_id: "taproot-private-id",
  recipient_script_pubkey_hex: script,
};
const quoteRow = {
  quote_id: "quote-1",
  quote_hash: "1".repeat(64),
  offering_id: "offering-1",
  offering_revision: "1",
  offering_hash: "2".repeat(64),
  sale_namespace_activation_id: "activation-1",
  sale_namespace_activation_generation: "1",
  fulfillment_kind: "spaces_native_v1",
  family: "spaces",
  owner_persona_id: "persona-1",
  namespace_root: "charizard",
  display_root: "charizard",
  handle_label: "charizardfan",
  display_identifier: "charizardfan@charizard",
  pricing_id: "platform_free_handles_v1",
  pricing_revision: "1",
  pricing_hash: "3".repeat(64),
  eligibility_policy_revision: "1",
  eligibility_policy_hash: "4".repeat(64),
  evidence_use_ids: [],
  evaluated_at: new Date("2026-09-23T16:00:00.000Z"),
  status: "quoted",
  quoted_at: new Date("2026-09-23T16:00:00.000Z"),
  expires_at: new Date("2026-09-23T16:02:00.000Z"),
  nationality_qualification_pin: null,
  ...recipientColumns,
};
const claimRow = {
  claim_id: "claim-1",
  owner_persona_id: "persona-1",
  offering_id: "offering-1",
  offering_hash: "2".repeat(64),
  quote_id: "quote-1",
  reservation_id: "reservation-1",
  reservation_hash: "5".repeat(64),
  sale_namespace_activation_id: "activation-1",
  sale_namespace_activation_generation: "1",
  fulfillment_kind: "spaces_native_v1",
  family: "spaces",
  namespace_root: "charizard",
  handle_label: "charizardfan",
  display_identifier: "charizardfan@charizard",
  pricing_revision: "1",
  pricing_hash: "3".repeat(64),
  state: "issuance_pending",
  safe_reason: "issuance_pending",
  grant_grant_id: null,
  created_at: new Date("2026-09-23T16:01:00.000Z"),
  updated_at: new Date("2026-09-23T16:01:00.000Z"),
  commits_paused: null,
  past_overdue_alert: false,
  ...recipientColumns,
};

describe("Spaces handle claim rows", () => {
  test("decode the owner projection without the private assignment id", () => {
    const quote = spacesQuoteFromRow(quoteRow);
    expect(quote.recipient).toEqual({
      kind: "persona_taproot_v1",
      network: "regtest",
      script_pubkey_hex: script,
    });
    expect(quote.handle).toEqual({
      family: "spaces",
      namespace_root: "charizard",
      handle_label: "charizardfan",
    });
    expect(JSON.stringify(quote)).not.toContain("taproot-private-id");
    expect(JSON.stringify(spacesClaimFromRow(claimRow))).not.toContain("taproot-private-id");
  });

  test("never decode an HNS row or a malformed recipient as Spaces", () => {
    const hns = { family: "hns", fulfillment_kind: "hosted_persona_v1" };
    expect(() => spacesQuoteFromRow({ ...quoteRow, ...hns })).toThrow("family");
    expect(() => spacesClaimFromRow({ ...claimRow, ...hns })).toThrow("family");
    expect(() =>
      spacesQuoteFromRow({ ...quoteRow, recipient_script_pubkey_hex: `0014${"a".repeat(40)}` }),
    ).toThrow("recipient");
    expect(() => spacesQuoteFromRow({ ...quoteRow, recipient_network: "signet" })).toThrow();
    expect(() => spacesClaimFromRow({ ...claimRow, state: "blocked" })).toThrow("state");
    expect(() => spacesClaimFromRow({ ...claimRow, commits_paused: "true" })).toThrow();
  });

  test("derive delayed only for a pending claim whose space is paused or which is overdue", () => {
    const delayed = (overrides: Record<string, unknown>) =>
      spacesClaimFromRow({ ...claimRow, ...overrides }).delayed;
    expect(delayed({})).toBe(false);
    expect(delayed({ commits_paused: false })).toBe(false);
    expect(delayed({ commits_paused: true })).toBe(true);
    expect(delayed({ past_overdue_alert: true })).toBe(true);
    for (const state of ["issued", "issuance_failed"]) {
      expect(
        delayed({
          state,
          safe_reason: state === "issued" ? null : "issuance_failed",
          commits_paused: true,
          past_overdue_alert: true,
        }),
      ).toBe(false);
    }
  });
});
