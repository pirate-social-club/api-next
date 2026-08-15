// Label-claim-rule matching and {label} substitution, ported pure from the
// old communities/handles/handle-label-claim-rules.ts. Persisted-rule reading
// stays in the application layer; expression normalization/validation of gate
// policies lives in the gates package and is injected via a parse callback.

export const MAX_LABEL_CLAIM_RULES = 20;
export const MAX_EXACT_SELECTOR_LABELS = 100;
export const LABEL_CLAIM_PLACEHOLDER = "{label}";

// Mirrors the ASCII branch of normalizeCommunityHandleLabel; selector entries
// must already be normalized labels, so punycode and suffix stripping do not
// apply here.
const NORMALIZED_LABEL_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export type LabelClaimRule = {
  label_claim_rule_id: string;
  position: number;
  selector_type: "exact" | "any";
  selector_labels_json: string | null;
  expression_json: string;
};

/** First matching rule wins: "any" matches everything, "exact" matches its labels. */
export function findMatchingLabelClaimRule(
  rules: LabelClaimRule[],
  labelNormalized: string,
): LabelClaimRule | null {
  for (const rule of rules) {
    if (rule.selector_type === "any") return rule;
    if (parseSelectorLabels(rule).includes(labelNormalized)) return rule;
  }
  return null;
}

function parseSelectorLabels(rule: LabelClaimRule): string[] {
  if (!rule.selector_labels_json?.trim()) {
    throw new Error("label_claim_rule_selector_malformed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rule.selector_labels_json);
  } catch {
    throw new Error("label_claim_rule_selector_malformed");
  }
  if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string")) {
    throw new Error("label_claim_rule_selector_malformed");
  }
  return parsed as string[];
}

/**
 * Parses a persisted rule expression and resolves `{label}` bindings against
 * the claim label. Fails closed: malformed persisted state denies the claim
 * rather than falling through to the namespace default.
 */
export function substituteLabelPlaceholders<T>(node: T, labelNormalized: string): unknown {
  if (Array.isArray(node)) {
    return node.map((child) => substituteLabelPlaceholders(child, labelNormalized));
  }
  if (!node || typeof node !== "object") return node;
  const record = node as Record<string, unknown>;
  if (
    record.type === "erc721_inventory_match" &&
    record.match &&
    typeof record.match === "object" &&
    !Array.isArray(record.match)
  ) {
    const match = Object.fromEntries(
      Object.entries(record.match as Record<string, unknown>).map(([key, value]) => {
        if (value === LABEL_CLAIM_PLACEHOLDER) return [key, labelNormalized];
        if (Array.isArray(value)) {
          return [
            key,
            value.map((entry) => (entry === LABEL_CLAIM_PLACEHOLDER ? labelNormalized : entry)),
          ];
        }
        return [key, value];
      }),
    );
    return { ...record, match };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, value]) => [
      key,
      substituteLabelPlaceholders(value, labelNormalized),
    ]),
  );
}

function findStrayPlaceholder(node: unknown, includeMatchValues: boolean): string | null {
  if (typeof node === "string") {
    return node.includes(LABEL_CLAIM_PLACEHOLDER) ? node : null;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findStrayPlaceholder(child, includeMatchValues);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const record = node as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (!includeMatchValues && key === "match" && record.type === "erc721_inventory_match") {
      continue;
    }
    const found = findStrayPlaceholder(value, includeMatchValues);
    if (found) return found;
  }
  return null;
}

export function containsLabelPlaceholder(node: unknown): boolean {
  return findStrayPlaceholder(node, true) != null;
}

/** Namespace-level expressions never run substitution, so the placeholder is banned there outright. */
export function assertNoLabelPlaceholder(policy: unknown): void {
  if (findStrayPlaceholder(policy, true)) {
    throw new Error("label_placeholder_only_in_label_claim_rules");
  }
}

/**
 * `{label}` is only meaningful as an erc721_inventory_match facet value, and
 * only as the entire value. Any other occurrence is rejected at write time so
 * persisted rules can never bind the label into fields where substitution does
 * not run.
 */
export function assertPlaceholderPositions(policy: unknown): void {
  if (findStrayPlaceholder(policy, false)) {
    throw new Error("label_placeholder_only_in_inventory_match_values");
  }
  assertMatchValuePlaceholders(policy);
}

function assertMatchValuePlaceholders(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) assertMatchValuePlaceholders(child);
    return;
  }
  if (!node || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (
    record.type === "erc721_inventory_match" &&
    record.match &&
    typeof record.match === "object" &&
    !Array.isArray(record.match)
  ) {
    for (const value of Object.values(record.match as Record<string, unknown>)) {
      const entries = Array.isArray(value) ? value : [value];
      for (const entry of entries) {
        if (
          typeof entry === "string" &&
          entry.includes(LABEL_CLAIM_PLACEHOLDER) &&
          entry !== LABEL_CLAIM_PLACEHOLDER
        ) {
          throw new Error("label_placeholder_must_be_entire_value");
        }
      }
    }
    return;
  }
  for (const value of Object.values(record)) assertMatchValuePlaceholders(value);
}

export function validateLabelClaimRulesInput(input: unknown): Array<{
  label_claim_rule_id: string | null;
  selector_type: "exact" | "any";
  selector_labels: string[] | null;
}> {
  if (!Array.isArray(input)) {
    throw new Error("label_claim_rules_must_be_array");
  }
  if (input.length > MAX_LABEL_CLAIM_RULES) {
    throw new Error("label_claim_rules_too_many");
  }
  const rules = input.map((raw) => validateLabelClaimRuleInput(raw));
  const seenIds = new Set<string>();
  for (const rule of rules) {
    if (!rule.label_claim_rule_id) continue;
    if (seenIds.has(rule.label_claim_rule_id)) {
      throw new Error("label_claim_rules_ids_must_be_unique");
    }
    seenIds.add(rule.label_claim_rule_id);
  }
  return rules;
}

function validateLabelClaimRuleInput(raw: unknown): {
  label_claim_rule_id: string | null;
  selector_type: "exact" | "any";
  selector_labels: string[] | null;
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("label_claim_rules_entries_must_be_objects");
  }
  const rule = raw as Record<string, unknown>;
  const labelClaimRuleId = parseWritableRuleId(rule.id);
  const selector = rule.selector;
  if (!selector || typeof selector !== "object" || Array.isArray(selector)) {
    throw new Error("label_claim_rules_require_selector");
  }
  const selectorType = (selector as Record<string, unknown>).type;
  const selectorLabels = (selector as Record<string, unknown>).labels;
  let labels: string[] | null = null;
  if (selectorType === "exact") {
    if (!Array.isArray(selectorLabels) || selectorLabels.length === 0) {
      throw new Error("exact_selectors_require_labels");
    }
    if (selectorLabels.length > MAX_EXACT_SELECTOR_LABELS) {
      throw new Error("exact_selectors_too_many_labels");
    }
    const seen = new Set<string>();
    labels = selectorLabels.map((value) => {
      if (typeof value !== "string" || !NORMALIZED_LABEL_PATTERN.test(value)) {
        throw new Error("exact_selector_labels_must_be_normalized");
      }
      if (seen.has(value)) {
        throw new Error("exact_selector_labels_must_be_unique");
      }
      seen.add(value);
      return value;
    });
  } else if (selectorType === "any") {
    if (selectorLabels != null && (!Array.isArray(selectorLabels) || selectorLabels.length > 0)) {
      throw new Error("any_selectors_must_not_carry_labels");
    }
  } else {
    throw new Error("selector_type_must_be_exact_or_any");
  }
  return {
    label_claim_rule_id: labelClaimRuleId,
    selector_type: selectorType,
    selector_labels: labels,
  };
}

function parseWritableRuleId(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !/^hlcr_[a-f0-9]{32}$/u.test(value)) {
    throw new Error("label_claim_rule_id_invalid");
  }
  return value.slice("hlcr_".length);
}
