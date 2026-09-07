import { describe, expect, test } from "bun:test";
import { normalizeStoredGatePolicy } from "../gates/policy-validation";
import {
  assertNoLabelPlaceholder,
  assertPlaceholderPositions,
  containsLabelPlaceholder,
  findMatchingLabelClaimRule,
  type LabelClaimRule,
  substituteLabelPlaceholders,
  validateLabelClaimRulesInput,
} from "./label-claim-rules";
import { normalizeCommunityHandleLabel } from "./policy";

describe("normalizeCommunityHandleLabel", () => {
  test("lowercases, trims, and strips a leading @ and any @suffix", () => {
    expect(normalizeCommunityHandleLabel("  Pirate ")).toEqual({
      labelNormalized: "pirate",
      labelDisplay: "pirate",
    });
    expect(normalizeCommunityHandleLabel("@Pirate")).toEqual({
      labelNormalized: "pirate",
      labelDisplay: "pirate",
    });
    expect(normalizeCommunityHandleLabel("pirate@handshake")).toEqual({
      labelNormalized: "pirate",
      labelDisplay: "pirate",
    });
  });

  test("accepts multi-hyphen ascii labels and punycode labels", () => {
    expect(normalizeCommunityHandleLabel("black-pearl-2").labelNormalized).toBe("black-pearl-2");
    expect(normalizeCommunityHandleLabel("xn--80ak6aa92e").labelNormalized).toBe("xn--80ak6aa92e");
  });

  test("rejects anything that is not a normalized ascii or punycode label", () => {
    for (const bad of [
      "",
      "  ",
      "-pirate",
      "pirate-",
      "pi rate",
      "PIRATE!",
      "underscores_ok",
      42,
      null,
    ]) {
      expect(() => normalizeCommunityHandleLabel(bad)).toThrow("invalid_desired_label");
    }
  });
});

describe("label claim rules", () => {
  const exactRule: LabelClaimRule = {
    label_claim_rule_id: "rule_1",
    position: 0,
    selector_type: "exact",
    selector_labels_json: JSON.stringify(["captain", "crew"]),
    expression_json: "{}",
  };
  const anyRule: LabelClaimRule = {
    label_claim_rule_id: "rule_2",
    position: 1,
    selector_type: "any",
    selector_labels_json: null,
    expression_json: "{}",
  };

  test("first matching rule wins; exact matches only its labels", () => {
    expect(findMatchingLabelClaimRule([exactRule, anyRule], "crew")?.label_claim_rule_id).toBe(
      "rule_1",
    );
    expect(findMatchingLabelClaimRule([exactRule, anyRule], "cook")?.label_claim_rule_id).toBe(
      "rule_2",
    );
    expect(findMatchingLabelClaimRule([exactRule], "cook")).toBeNull();
    expect(findMatchingLabelClaimRule([anyRule, exactRule], "anything")?.label_claim_rule_id).toBe(
      "rule_2",
    );
  });

  test("an exact rule with malformed selector labels fails closed", () => {
    expect(() =>
      findMatchingLabelClaimRule([{ ...exactRule, selector_labels_json: "{" }], "crew"),
    ).toThrow();
    expect(() =>
      findMatchingLabelClaimRule([{ ...exactRule, selector_labels_json: null }], "crew"),
    ).toThrow();
  });

  test("{label} substitution runs only inside inventory-match facet values", () => {
    const expression = {
      version: 1,
      expression: {
        op: "and",
        children: [
          { op: "gate", gate: { type: "unique_human", provider: "self" } },
          {
            op: "gate",
            gate: {
              type: "erc721_inventory_match",
              provider: "courtyard",
              match: { category: "{label}", brand: ["acme", "{label}"] },
            },
          },
        ],
      },
    };
    const substituted = substituteLabelPlaceholders(expression, "pirate");
    expect(containsLabelPlaceholder(substituted)).toBe(false);
    const gate = (substituted as typeof expression).expression.children[1];
    expect(gate).toMatchObject({
      gate: { match: { category: "pirate", brand: ["acme", "pirate"] } },
    });
    // Substitution never leaks into other fields.
    expect((substituted as typeof expression).expression.children[0]).toEqual(
      expression.expression.children[0],
    );
  });

  test("a stray placeholder outside inventory-match values is rejected and fails closed", () => {
    const stray = {
      op: "gate",
      gate: { type: "erc721_holding", contract_address: "{label}" },
    };
    expect(containsLabelPlaceholder(stray)).toBe(true);
    expect(() => assertNoLabelPlaceholder(stray)).toThrow();
    expect(() => assertPlaceholderPositions(stray)).toThrow();
    // A partial placeholder inside a facet value is rejected too.
    expect(() =>
      assertPlaceholderPositions({
        op: "gate",
        gate: { type: "erc721_inventory_match", match: { category: "the-{label}" } },
      }),
    ).toThrow("label_placeholder_must_be_entire_value");
    // A well-formed inventory-match placeholder passes position checks.
    expect(() =>
      assertPlaceholderPositions({
        op: "gate",
        gate: { type: "erc721_inventory_match", match: { category: "{label}" } },
      }),
    ).not.toThrow();
  });

  test("rule input validation enforces caps, normalized unique labels, and id shape", () => {
    const validExpression = {
      version: 1,
      expression: { op: "gate", gate: { type: "unique_human", provider: "self" } },
    };
    expect(
      validateLabelClaimRulesInput(
        [
          {
            selector: { type: "exact", labels: ["pirate"] },
            claim_gate_expression: validExpression,
          },
          { selector: { type: "any", labels: null }, claim_gate_expression: validExpression },
        ],
        normalizeStoredGatePolicy,
      ),
    ).toMatchObject([
      {
        label_claim_rule_id: null,
        selector_type: "exact",
        selector_labels: ["pirate"],
        expression: { version: 1 },
      },
      {
        label_claim_rule_id: null,
        selector_type: "any",
        selector_labels: null,
        expression: { version: 1 },
      },
    ]);
    expect(() => validateLabelClaimRulesInput("nope", normalizeStoredGatePolicy)).toThrow();
    expect(() =>
      validateLabelClaimRulesInput(
        Array.from({ length: 21 }, () => ({
          selector: { type: "any" },
          claim_gate_expression: validExpression,
        })),
        normalizeStoredGatePolicy,
      ),
    ).toThrow("label_claim_rules_too_many");
    expect(() =>
      validateLabelClaimRulesInput(
        [{ selector: { type: "exact", labels: [] }, claim_gate_expression: validExpression }],
        normalizeStoredGatePolicy,
      ),
    ).toThrow("exact_selectors_require_labels");
    expect(() =>
      validateLabelClaimRulesInput(
        [
          {
            selector: { type: "exact", labels: ["Bad Label"] },
            claim_gate_expression: validExpression,
          },
        ],
        normalizeStoredGatePolicy,
      ),
    ).toThrow("exact_selector_labels_must_be_normalized");
    expect(() =>
      validateLabelClaimRulesInput(
        [
          {
            selector: { type: "exact", labels: ["pirate", "pirate"] },
            claim_gate_expression: validExpression,
          },
        ],
        normalizeStoredGatePolicy,
      ),
    ).toThrow("exact_selector_labels_must_be_unique");
    expect(() =>
      validateLabelClaimRulesInput(
        [{ id: "not-an-id", selector: { type: "any" }, claim_gate_expression: validExpression }],
        normalizeStoredGatePolicy,
      ),
    ).toThrow("label_claim_rule_id_invalid");
    expect(() =>
      validateLabelClaimRulesInput(
        [{ selector: { type: "any", labels: ["pirate"] }, claim_gate_expression: validExpression }],
        normalizeStoredGatePolicy,
      ),
    ).toThrow("any_selectors_must_not_carry_labels");
    expect(() =>
      validateLabelClaimRulesInput(
        [{ selector: { type: "regex" }, claim_gate_expression: validExpression }],
        normalizeStoredGatePolicy,
      ),
    ).toThrow("selector_type_must_be_exact_or_any");
  });

  test("old serialized claim expressions are validated before a rule is accepted", () => {
    const oldSerializedRule = JSON.parse(`{
      "selector": { "type": "any", "labels": null },
      "claim_gate_expression": {
        "version": 1,
        "expression": {
          "op": "gate",
          "gate": { "type": "not-a-policy" }
        }
      }
    }`);

    expect(() =>
      validateLabelClaimRulesInput([oldSerializedRule], normalizeStoredGatePolicy),
    ).toThrow();
  });

  test("normalizes each old expression once before checking placeholder positions", () => {
    const oldSerializedExpression = JSON.parse(`{
      "version": 1,
      "expression": {
        "op": "and",
        "children": [
          { "op": "gate", "gate": { "gate_id": "gate_1", "type": "unique_human", "provider": "self" } },
          { "op": "gate", "gate": { "gate_id": "gate_2", "type": "unique_human", "provider": "zkpassport" } }
        ]
      }
    }`);
    let calls = 0;
    const result = validateLabelClaimRulesInput(
      [{ selector: { type: "any" }, claim_gate_expression: oldSerializedExpression }],
      (expression) => {
        calls += 1;
        return normalizeStoredGatePolicy(expression);
      },
    );
    expect(calls).toBe(1);
    expect(result[0]?.expression).toMatchObject({
      expression: {
        op: "and",
        children: [{ gate: { gate_id: "gate_1" } }, { gate: { gate_id: "gate_2" } }],
      },
    });
  });

  test("illegal placeholder positions fail after expression normalization", () => {
    const oldSerializedRule = JSON.parse(`{
      "selector": { "type": "any", "labels": null },
      "claim_gate_expression": {
        "version": 1,
        "expression": {
          "op": "gate",
          "gate": {
            "type": "erc721_inventory_match",
            "provider": "courtyard",
            "chain_namespace": "eip155:1",
            "contract_address": "0x0000000000000000000000000000000000000001",
            "min_quantity": 1,
            "match": { "category": "trading_card", "subject": "the-{label}" }
          }
        }
      }
    }`);
    expect(() =>
      validateLabelClaimRulesInput([oldSerializedRule], normalizeStoredGatePolicy),
    ).toThrow("label_placeholder_must_be_entire_value");
  });

  test("a whole inventory facet placeholder remains valid", () => {
    const result = validateLabelClaimRulesInput(
      [
        {
          selector: { type: "any" },
          claim_gate_expression: {
            version: 1,
            expression: {
              op: "gate",
              gate: {
                type: "erc721_inventory_match",
                provider: "courtyard",
                chain_namespace: "eip155:1",
                contract_address: "0x0000000000000000000000000000000000000001",
                min_quantity: 1,
                match: { category: "trading_card", subject: "{label}" },
              },
            },
          },
        },
      ],
      normalizeStoredGatePolicy,
    );
    expect(result[0]?.expression).toMatchObject({ expression: { op: "gate" } });
  });
});
