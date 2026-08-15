import { describe, expect, test } from "bun:test";
import { evaluateErc721HoldingAtom, evaluateErc721InventoryMatchAtom } from "./erc721";
import { isPowSatisfiableGatePolicy } from "./open-participation";
import { evaluateProofOfWorkAtom } from "./proof-of-work";
import { evaluateWalletScoreAtom, type WalletScoreEvidence } from "./wallet-score";

describe("wallet-score atom evaluator", () => {
  const atom = { type: "wallet_score" as const, provider: "passport" as const, minimum_score: 70 };

  test("requires verified Passport evidence, a finite score, and passing_score", () => {
    expect(
      evaluateWalletScoreAtom({
        atom,
        evidence: {
          state: "verified",
          provider: "passport",
          score_decimal: "71",
          passing_score: true,
        },
      }),
    ).toMatchObject({ outcome: "passed", passed: true, requiredAction: null });
    expect(
      evaluateWalletScoreAtom({
        atom,
        evidence: {
          state: "verified",
          provider: "passport",
          score_decimal: "71",
          passing_score: false,
        },
      }),
    ).toMatchObject({ outcome: "terminal_mismatch", passed: false });
    expect(
      evaluateWalletScoreAtom({
        atom,
        evidence: {
          state: "verified",
          provider: "passport",
          score_decimal: "not-a-score",
          passing_score: true,
        },
      }),
    ).toMatchObject({ outcome: "terminal_mismatch", passed: false });
  });

  test("requests Passport for missing, unverified, or wrong-provider evidence", () => {
    const evidenceCases: Array<WalletScoreEvidence | null> = [
      null,
      { state: "unverified", provider: "passport", score_decimal: null, passing_score: null },
      { state: "verified", provider: "self", score_decimal: "90", passing_score: true },
    ];
    for (const evidence of evidenceCases) {
      expect(evaluateWalletScoreAtom({ atom, evidence })).toMatchObject({
        outcome: "action_required",
        requiredAction: { provider: "passport", capability: "wallet_score", minimum_score: 70 },
      });
    }
  });
});

describe("ERC-721 atom evaluators", () => {
  test("holding defaults to one and distinguishes insufficient from unavailable", () => {
    const atom = {
      type: "erc721_holding" as const,
      chain_namespace: "eip155:1" as const,
      contract_address: "0xabc",
    };
    expect(
      evaluateErc721HoldingAtom({ atom, facts: { quantity: 1, unavailable: false } }),
    ).toMatchObject({
      outcome: "passed",
      passed: true,
    });
    expect(
      evaluateErc721HoldingAtom({
        atom: { ...atom, min_count: 2 },
        facts: { quantity: 1, unavailable: false },
      }),
    ).toMatchObject({
      outcome: "action_required",
      requiredAction: {
        provider: "wallet",
        capability: "erc721_holding",
        chain_namespace: "eip155:1",
        contract_address: "0xabc",
        min_quantity: 2,
      },
    });
    expect(
      evaluateErc721HoldingAtom({ atom, facts: { quantity: null, unavailable: true } }),
    ).toMatchObject({
      outcome: "provider_unavailable",
      requiredAction: null,
    });
  });

  test("inventory matching preserves token keys and configured minimum quantity", () => {
    const atom = {
      type: "erc721_inventory_match" as const,
      provider: "courtyard" as const,
      chain_namespace: "eip155:1" as const,
      contract_address: "0xabc",
      min_quantity: 2,
      match: { category: "trading_card", subject: "Charizard" },
    };
    const facts = {
      matchedQuantity: 1,
      matchedTokenKeys: ["eip155:1:0xabc:1"],
      unavailable: false,
    };
    expect(evaluateErc721InventoryMatchAtom({ atom, facts })).toMatchObject({
      outcome: "action_required",
      matchedTokenKeys: facts.matchedTokenKeys,
      requiredAction: { capability: "erc721_inventory_match", min_quantity: 2 },
    });
    expect(
      evaluateErc721InventoryMatchAtom({ atom, facts: { ...facts, unavailable: true } }),
    ).toMatchObject({
      outcome: "provider_unavailable",
      requiredAction: null,
    });
  });
});

describe("proof-of-work atom evaluator", () => {
  const atom = { type: "altcha_pow" as const };

  test("preview and diagnose request the exact action without consuming evidence", () => {
    const result = evaluateProofOfWorkAtom({
      atom,
      mode: "preview",
      actorUserId: "user_1",
      scope: "community_join",
      action: "join",
      verifiedEvidence: { actorUserId: "user_1", scope: "community_join", action: "join" },
    });
    expect(result).toMatchObject({
      outcome: "action_required",
      requiredAction: { provider: "altcha", capability: "altcha_pow", scope: "community_join" },
    });
  });

  test("enforce passes only actor-, scope-, and action-bound verified evidence", () => {
    const input = {
      atom,
      mode: "enforce" as const,
      actorUserId: "user_1",
      scope: "community_join",
      action: "join",
    };
    expect(
      evaluateProofOfWorkAtom({
        ...input,
        verifiedEvidence: { actorUserId: "user_1", scope: "community_join", action: "join" },
      }),
    ).toMatchObject({ outcome: "passed", passed: true });
    expect(
      evaluateProofOfWorkAtom({
        ...input,
        verifiedEvidence: { actorUserId: "user_2", scope: "community_join", action: "join" },
      }),
    ).toMatchObject({ outcome: "action_required", passed: false });
  });
});

describe("proof-of-work open participation", () => {
  test("keeps old AND/OR precedence for bare and nested proof-of-work policies", () => {
    const bare = JSON.parse(
      '{"version":1,"expression":{"op":"gate","gate":{"type":"altcha_pow"}}}',
    );
    const conjunction = JSON.parse(`{
      "version": 1,
      "expression": {
        "op": "and",
        "children": [
          { "op": "gate", "gate": { "type": "altcha_pow" } },
          { "op": "gate", "gate": { "type": "unique_human", "provider": "self" } }
        ]
      }
    }`);
    const disjunction = JSON.parse(`{
      "version": 1,
      "expression": {
        "op": "or",
        "children": [
          { "op": "gate", "gate": { "type": "altcha_pow" } },
          { "op": "gate", "gate": { "type": "unique_human", "provider": "self" } }
        ]
      }
    }`);
    const nestedAnd = JSON.parse(`{
      "version": 1,
      "expression": {
        "op": "and",
        "children": [
          { "op": "and", "children": [
            { "op": "gate", "gate": { "type": "altcha_pow" } },
            { "op": "gate", "gate": { "type": "altcha_pow" } }
          ] }
        ]
      }
    }`);
    const identityOnly = JSON.parse(
      '{"version":1,"expression":{"op":"gate","gate":{"type":"unique_human","provider":"self"}}}',
    );
    const empty = JSON.parse('{"version":1,"expression":{"op":"and","children":[]}}');
    expect(isPowSatisfiableGatePolicy(bare)).toBe(true);
    expect(isPowSatisfiableGatePolicy(conjunction)).toBe(false);
    expect(isPowSatisfiableGatePolicy(disjunction)).toBe(true);
    expect(isPowSatisfiableGatePolicy(nestedAnd)).toBe(true);
    expect(isPowSatisfiableGatePolicy(identityOnly)).toBe(false);
    expect(isPowSatisfiableGatePolicy(empty)).toBe(false);
    expect(isPowSatisfiableGatePolicy(null)).toBe(false);
  });
});
