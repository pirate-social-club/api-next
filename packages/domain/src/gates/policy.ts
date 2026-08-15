// Pure gate-policy expression evaluation, extracted from the old
// membership/gate-policy-evaluation.ts. Atom evaluation is injected as a
// function so I/O-bound atoms (chain reads, altcha verification) live in the
// application layer while composition and outcome semantics stay here.

export type GateEvaluationOutcome =
  | "passed"
  | "action_required"
  | "provider_unavailable"
  | "terminal_mismatch";

export type RequiredActionNode =
  | { readonly kind: "action"; readonly gate_id?: string | null; readonly [field: string]: unknown }
  | {
      readonly kind: "set";
      readonly mode: "all" | "any";
      readonly items: readonly RequiredActionNode[];
    };

export type RequiredActionSet = {
  readonly kind: "set";
  readonly mode: "all" | "any";
  readonly items: readonly RequiredActionNode[];
};

export type GateAtomIdentity = { readonly gate_id?: string | null };

export type GateExpressionNode<Atom> =
  | { readonly op: "gate"; readonly gate: Atom & GateAtomIdentity }
  | { readonly op: "gate"; readonly gate: Atom; readonly gate_id?: string | null }
  | { readonly op: "and" | "or"; readonly children: readonly GateExpressionNode<Atom>[] };

export type GatePolicy<Atom> = {
  readonly version: 1;
  readonly expression: GateExpressionNode<Atom>;
};

export type AtomEvaluation = {
  readonly outcome: GateEvaluationOutcome;
  readonly passed: boolean;
  readonly requiredAction: RequiredActionNode | null;
};

export type ExpressionEvaluation = {
  readonly outcome: GateEvaluationOutcome;
  readonly passed: boolean;
  readonly requiredActionSet: RequiredActionSet | null;
};

export function composeExpressionOutcome(
  op: "and" | "or",
  children: readonly { readonly outcome: GateEvaluationOutcome }[],
): GateEvaluationOutcome {
  const outcomes = new Set(children.map((child) => child.outcome));
  if (op === "or") {
    if (outcomes.has("passed")) return "passed";
    if (outcomes.has("action_required")) return "action_required";
    if (outcomes.has("provider_unavailable")) return "provider_unavailable";
    return "terminal_mismatch";
  }

  if (outcomes.has("terminal_mismatch")) return "terminal_mismatch";
  if (outcomes.has("provider_unavailable")) return "provider_unavailable";
  if (outcomes.has("action_required")) return "action_required";
  return "passed";
}

export function collapseActionSet(set: RequiredActionSet): RequiredActionSet {
  const items: RequiredActionNode[] = [];
  for (const item of set.items) {
    if (item.kind === "set" && item.mode === set.mode) {
      items.push(...item.items);
    } else {
      items.push(item);
    }
  }
  return { ...set, items };
}

// Evaluate an expression tree over already-evaluated leaf atoms. The tree is
// walked depth-first; children of a gate node are evaluated by `evaluateAtom`.
export function evaluateGateExpression<Atom>(
  expression: GateExpressionNode<Atom>,
  evaluateAtom: (atom: Atom, gateId: string | null) => AtomEvaluation,
): ExpressionEvaluation {
  if (expression.op === "gate") {
    const gate = expression.gate as Atom & GateAtomIdentity;
    const gateId = Object.hasOwn(gate, "gate_id")
      ? (gate.gate_id ?? null)
      : "gate_id" in expression
        ? (expression.gate_id ?? null)
        : null;
    const result = evaluateAtom(expression.gate, gateId);
    return {
      outcome: result.outcome,
      passed: result.passed,
      requiredActionSet:
        result.passed || !result.requiredAction
          ? null
          : collapseActionSet({
              kind: "set",
              mode: "all",
              items: [{ ...result.requiredAction, gate_id: gateId } as RequiredActionNode],
            }),
    };
  }

  const children = expression.children.map((child) => evaluateGateExpression(child, evaluateAtom));
  const passed =
    expression.op === "and"
      ? children.every((child) => child.passed)
      : children.some((child) => child.passed);
  const failedChildren = children.filter((child) => !child.passed);
  const requiredItems = failedChildren
    .filter((child) => child.outcome === "action_required")
    .map((child) => child.requiredActionSet)
    .filter((item): item is RequiredActionSet => item != null);
  const outcome = composeExpressionOutcome(expression.op, children);

  return {
    outcome,
    passed,
    requiredActionSet:
      outcome !== "action_required"
        ? null
        : collapseActionSet({
            kind: "set",
            mode: expression.op === "and" ? "all" : "any",
            items: requiredItems,
          }),
  };
}
