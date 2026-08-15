import { describe, expect, test } from "bun:test";
import {
  type AtomEvaluation,
  composeExpressionOutcome,
  type ExpressionEvaluation,
  evaluateGateExpression,
  type GateExpressionNode,
} from "./policy";

// Composition semantics ported from the old gate-policy-evaluation expression
// tree; atom evaluation is table-driven by outcome.

type Atom = { readonly label: string };

function atom(label: string): GateExpressionNode<Atom> {
  return { op: "gate", gate: { label } };
}

function evaluate(outcome: AtomEvaluation["outcome"]): AtomEvaluation {
  const passed = outcome === "passed";
  return {
    outcome,
    passed,
    requiredAction: passed ? null : { kind: "action", capability: `capability_for_${outcome}` },
  };
}

const outcomes = [
  "passed",
  "action_required",
  "provider_unavailable",
  "terminal_mismatch",
] as const;

function run(
  op: "and" | "or",
  childOutcomes: readonly (typeof outcomes)[number][],
): ExpressionEvaluation {
  const expression: GateExpressionNode<Atom> = {
    op,
    children: childOutcomes.map((outcome, index) => atom(`gate_${index}_${outcome}`)),
  };
  return evaluateGateExpression(expression, (candidate) =>
    evaluate(outcomes.find((outcome) => candidate.label.endsWith(outcome)) ?? "passed"),
  );
}

describe("composeExpressionOutcome", () => {
  test("or: passed wins, then action_required, then provider_unavailable", () => {
    const precedence = [
      "passed",
      "action_required",
      "provider_unavailable",
      "terminal_mismatch",
    ] as const;
    for (const [low, lowOutcome] of precedence.entries()) {
      for (const [high, highOutcome] of precedence.entries()) {
        if (high >= low) continue;
        expect(composeExpressionOutcome("or", [evaluate(lowOutcome), evaluate(highOutcome)])).toBe(
          highOutcome,
        );
      }
    }
    expect(
      composeExpressionOutcome("or", [
        evaluate("terminal_mismatch"),
        evaluate("terminal_mismatch"),
      ]),
    ).toBe("terminal_mismatch");
  });

  test("and: terminal_mismatch wins, then provider_unavailable, then action_required", () => {
    const precedence = [
      "terminal_mismatch",
      "provider_unavailable",
      "action_required",
      "passed",
    ] as const;
    for (const [low, lowOutcome] of precedence.entries()) {
      for (const [high, highOutcome] of precedence.entries()) {
        if (high >= low) continue;
        expect(composeExpressionOutcome("and", [evaluate(lowOutcome), evaluate(highOutcome)])).toBe(
          highOutcome,
        );
      }
    }
  });
});

describe("evaluateGateExpression", () => {
  test("passed/failed follows the boolean op across the full outcome table", () => {
    expect(run("and", ["passed", "passed"])).toMatchObject({ passed: true, outcome: "passed" });
    expect(run("and", ["passed", "terminal_mismatch"])).toMatchObject({
      passed: false,
      outcome: "terminal_mismatch",
    });
    expect(run("and", ["action_required", "passed"])).toMatchObject({
      passed: false,
      outcome: "action_required",
    });
    expect(run("or", ["terminal_mismatch", "passed"])).toMatchObject({
      passed: true,
      outcome: "passed",
    });
    expect(run("or", ["terminal_mismatch", "action_required"])).toMatchObject({
      passed: false,
      outcome: "action_required",
    });
    expect(run("or", ["terminal_mismatch", "provider_unavailable"])).toMatchObject({
      passed: false,
      outcome: "provider_unavailable",
    });
    expect(run("or", ["terminal_mismatch", "terminal_mismatch"])).toMatchObject({
      passed: false,
      outcome: "terminal_mismatch",
    });
  });

  test("an action_required set is produced only for action_required failures", () => {
    const result = run("and", ["action_required", "action_required"]);
    expect(result.outcome).toBe("action_required");
    expect(result.requiredActionSet).toMatchObject({
      kind: "set",
      mode: "all",
      items: [{ kind: "action" }, { kind: "action" }],
    });
    expect(run("and", ["terminal_mismatch", "action_required"]).requiredActionSet).toBeNull();
    expect(run("and", ["passed", "passed"]).requiredActionSet).toBeNull();
    expect(run("or", ["action_required", "action_required"]).requiredActionSet).toMatchObject({
      mode: "any",
    });
  });

  test("action sets collapse across nesting when modes agree and stay nested when they differ", () => {
    const expression: GateExpressionNode<Atom> = {
      op: "and",
      children: [
        { op: "or", children: [atom("gate_0_action_required"), atom("gate_1_action_required")] },
        atom("gate_2_action_required"),
      ],
    };
    // The inner or-set (mode any) inside an and-set (mode all) stays nested.
    const result = evaluateGateExpression(expression, (candidate) =>
      evaluate(candidate.label.endsWith("action_required") ? "action_required" : "passed"),
    );
    expect(result.outcome).toBe("action_required");
    expect(result.requiredActionSet?.mode).toBe("all");
    expect(
      result.requiredActionSet?.items.some((item) => item.kind === "set" && item.mode === "any"),
    ).toBe(true);

    const flat: GateExpressionNode<Atom> = {
      op: "and",
      children: [
        { op: "and", children: [atom("gate_0_action_required"), atom("gate_1_action_required")] },
        atom("gate_2_action_required"),
      ],
    };
    // Two agreeing all-sets flatten into one list of three actions.
    const flatResult = evaluateGateExpression(flat, () => evaluate("action_required"));
    expect(flatResult.requiredActionSet).toMatchObject({
      kind: "set",
      mode: "all",
      items: [{ kind: "action" }, { kind: "action" }, { kind: "action" }],
    });
  });

  test("a passing gate produces no action and stamps the gate id on failing actions", () => {
    const withId: GateExpressionNode<Atom> = {
      op: "gate",
      gate: { label: "g" },
      gate_id: "gate_9",
    };
    expect(evaluateGateExpression(withId, () => evaluate("passed")).requiredActionSet).toBeNull();
    expect(
      evaluateGateExpression(withId, () => evaluate("action_required")).requiredActionSet,
    ).toMatchObject({
      items: [{ kind: "action", gate_id: "gate_9" }],
    });
  });
});
