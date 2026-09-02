import { describe, expect, test } from "bun:test";
import {
  type AccountErasureAdmissionSnapshot,
  evaluateAccountErasureAdmission,
} from "./account-erasure-orchestration.ts";

const clearSnapshot = (): AccountErasureAdmissionSnapshot => ({
  community_ownership: "clear",
  hns_authority: "clear",
  operator_principal: "clear",
  persona_wallet_custody: "clear",
  financial_effects: "clear",
  required_authorities: "clear",
});

describe("account erasure admission", () => {
  test("admits only a complete clear snapshot", () => {
    expect(evaluateAccountErasureAdmission(clearSnapshot())).toEqual({ outcome: "admitted" });
  });

  test("maps blocked owners to the ratified conflict taxonomy in stable order", () => {
    expect(
      evaluateAccountErasureAdmission({
        community_ownership: "blocked",
        hns_authority: "blocked",
        operator_principal: "blocked",
        persona_wallet_custody: "blocked",
        financial_effects: "blocked",
        required_authorities: "clear",
      }),
    ).toEqual({
      outcome: "conflict",
      conflicts: [
        {
          category: "community_owner_transfer_required",
          owners: ["community_ownership"],
        },
        {
          category: "hns_authority_transfer_required",
          owners: ["hns_authority"],
        },
        { category: "operator_policy_required", owners: ["operator_principal"] },
        { category: "custody_not_empty", owners: ["persona_wallet_custody"] },
        { category: "financial_effect_pending", owners: ["financial_effects"] },
      ],
    });
  });

  test("aggregates unavailable checks without hiding the affected owners", () => {
    expect(
      evaluateAccountErasureAdmission({
        ...clearSnapshot(),
        persona_wallet_custody: "unknown",
        financial_effects: "unknown",
        required_authorities: "unknown",
      }),
    ).toEqual({
      outcome: "conflict",
      conflicts: [
        {
          category: "custody_status_unknown",
          owners: ["persona_wallet_custody", "financial_effects", "required_authorities"],
        },
      ],
    });
  });

  test("fails closed when a required authority is explicitly blocked", () => {
    expect(
      evaluateAccountErasureAdmission({
        ...clearSnapshot(),
        required_authorities: "blocked",
      }),
    ).toEqual({
      outcome: "conflict",
      conflicts: [{ category: "custody_status_unknown", owners: ["required_authorities"] }],
    });
  });

  test("fails closed when an untyped runtime source omits a check", () => {
    const incomplete = { ...clearSnapshot(), hns_authority: undefined };

    expect(
      evaluateAccountErasureAdmission(incomplete as unknown as AccountErasureAdmissionSnapshot),
    ).toEqual({
      outcome: "conflict",
      conflicts: [{ category: "custody_status_unknown", owners: ["hns_authority"] }],
    });
  });

  test("returns specific and unknown conflicts together", () => {
    expect(
      evaluateAccountErasureAdmission({
        ...clearSnapshot(),
        community_ownership: "blocked",
        hns_authority: "unknown",
      }),
    ).toEqual({
      outcome: "conflict",
      conflicts: [
        {
          category: "community_owner_transfer_required",
          owners: ["community_ownership"],
        },
        { category: "custody_status_unknown", owners: ["hns_authority"] },
      ],
    });
  });
});
