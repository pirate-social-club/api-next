import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { SaleNamespaceActivationV1 } from "./handle-sales.ts";
import {
  CreateSpacesSaleNamespaceActivationV1,
  SpacesOperatorFundingV1,
  SpacesSaleNamespaceActivationV1,
  SpacesSaleReadinessV1,
} from "./handle-sales-spaces.ts";

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
