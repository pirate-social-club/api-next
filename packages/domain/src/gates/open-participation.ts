/** True when proof-of-work alone satisfies every branch of an expression. */
export function isPowSatisfiableExpression(expression: unknown): boolean {
  if (!isRecord(expression)) return false;
  if (expression.op === "gate") {
    return isRecord(expression.gate) && expression.gate.type === "altcha_pow";
  }
  if ((expression.op !== "and" && expression.op !== "or") || !Array.isArray(expression.children)) {
    return false;
  }
  if (expression.children.length === 0) return false;
  return expression.op === "or"
    ? expression.children.some(isPowSatisfiableExpression)
    : expression.children.every(isPowSatisfiableExpression);
}

export function isPowSatisfiableGatePolicy(
  policy: { readonly expression: unknown } | null,
): boolean {
  return policy != null && isPowSatisfiableExpression(policy.expression);
}

export const isSatisfiedByPowAlone = isPowSatisfiableExpression;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
