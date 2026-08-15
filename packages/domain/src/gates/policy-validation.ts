import { normalizeIdentityCountryCode } from "./country-codes";
import type { GateExpressionNode, GatePolicy } from "./policy";

const MAX_GATE_POLICY_DEPTH = 4;
const MAX_GATE_POLICY_ATOMS = 20;
const GATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;
const DOCUMENT_PROOF_PROVIDERS = ["self", "zkpassport"] as const;

export type GateAtom =
  | { readonly type: "altcha_pow" }
  | { readonly type: "unique_human"; readonly provider: "very" | "self" | "zkpassport" }
  | {
      readonly type: "minimum_age";
      readonly provider: "self";
      readonly accepted_providers?: readonly (typeof DOCUMENT_PROOF_PROVIDERS)[number][];
      readonly minimum_age: number;
    }
  | {
      readonly type: "nationality";
      readonly provider: "self";
      readonly accepted_providers?: readonly (typeof DOCUMENT_PROOF_PROVIDERS)[number][];
      readonly allowed: readonly string[];
    }
  | {
      readonly type: "gender";
      readonly provider: "self";
      readonly accepted_providers?: readonly (typeof DOCUMENT_PROOF_PROVIDERS)[number][];
      readonly allowed: readonly ("M" | "F")[];
    }
  | { readonly type: "wallet_score"; readonly provider: "passport"; readonly minimum_score: number }
  | {
      readonly type: "erc721_holding";
      readonly chain_namespace: "eip155:1" | "eip155:8453";
      readonly contract_address: string;
      readonly min_count?: number;
    }
  | {
      readonly type: "erc721_inventory_match";
      readonly provider: "courtyard";
      readonly chain_namespace: "eip155:1" | "eip155:137";
      readonly contract_address: string;
      readonly min_quantity: number;
      readonly match: Record<string, string | string[]>;
    }
  | {
      readonly type: "asset_balance";
      readonly asset_id: string;
      readonly min_amount_atomic: string;
    };

export type ValidatedGatePolicy = GatePolicy<GateAtom>;

/** Strictly validate a newly authored policy and return its normalized form. */
export function validateGatePolicy(input: unknown): ValidatedGatePolicy {
  return validateGatePolicyInternal(input, "strict");
}

/** Decode persisted policies, retaining valid atom-level identities. */
export function normalizeStoredGatePolicy(input: unknown): ValidatedGatePolicy {
  return validateGatePolicyInternal(input, "repair_identity");
}

function validateGatePolicyInternal(
  input: unknown,
  identityMode: "strict" | "repair_identity",
): ValidatedGatePolicy {
  if (!isRecord(input) || input.version !== 1) {
    throw new Error("gate_policy_malformed");
  }
  const atomCount = { value: 0 };
  const gateIds = new Set<string>();
  const expression = validateExpression(input.expression, 1, atomCount, gateIds, identityMode, [0]);
  if (atomCount.value === 0) throw new Error("gate_policy_requires_gate");
  if (identityMode === "strict") assertRequiredIdentityCapabilities(expression);
  return { version: 1, expression };
}

function validateExpression(
  input: unknown,
  depth: number,
  atomCount: { value: number },
  gateIds: Set<string>,
  identityMode: "strict" | "repair_identity",
  path: number[],
): GateExpressionNode<GateAtom> {
  if (depth > MAX_GATE_POLICY_DEPTH || !isRecord(input)) {
    throw new Error("gate_policy_expression_malformed");
  }
  if (input.op === "and" || input.op === "or") {
    if (!Array.isArray(input.children) || input.children.length === 0) {
      throw new Error("gate_policy_expression_children_required");
    }
    if (input.children.length > MAX_GATE_POLICY_ATOMS) {
      throw new Error("gate_policy_expression_too_many_children");
    }
    return {
      op: input.op,
      children: input.children.map((child, index) =>
        validateExpression(child, depth + 1, atomCount, gateIds, identityMode, [...path, index]),
      ),
    };
  }
  if (input.op !== "gate") throw new Error("gate_policy_expression_op_invalid");
  atomCount.value += 1;
  if (atomCount.value > MAX_GATE_POLICY_ATOMS) throw new Error("gate_policy_too_many_atoms");
  return {
    op: "gate",
    gate: validateAtom(input.gate, gateIds, identityMode, path),
  };
}

function validateAtom(
  input: unknown,
  gateIds: Set<string>,
  identityMode: "strict" | "repair_identity",
  path: number[],
): GateAtom & { readonly gate_id: string } {
  if (!isRecord(input) || typeof input.type !== "string") {
    throw new Error("gate_atom_malformed");
  }
  const explicitId = input.gate_id;
  let gateId: string;
  if (
    typeof explicitId === "string" &&
    GATE_ID_PATTERN.test(explicitId) &&
    !gateIds.has(explicitId)
  ) {
    gateId = explicitId;
  } else if (identityMode === "strict" && explicitId != null) {
    throw new Error("gate_atom_gate_id_invalid");
  } else {
    gateId = `legacy_${path.join("_")}`;
    let suffix = 0;
    while (gateIds.has(gateId)) {
      suffix += 1;
      gateId = `legacy_${path.join("_")}_repair${suffix}`;
    }
  }
  gateIds.add(gateId);
  const identity = { gate_id: gateId } as const;

  switch (input.type) {
    case "altcha_pow":
      return { ...identity, type: "altcha_pow" };
    case "unique_human":
      if (!isOneOf(input.provider, ["very", "self", "zkpassport"] as const)) {
        throw new Error("unique_human_provider_invalid");
      }
      return { ...identity, type: "unique_human", provider: input.provider };
    case "minimum_age": {
      const minimumAge = input.minimum_age;
      if (
        input.provider !== "self" ||
        typeof minimumAge !== "number" ||
        !Number.isInteger(minimumAge) ||
        minimumAge < 18 ||
        minimumAge > 125
      ) {
        throw new Error("minimum_age_invalid");
      }
      return {
        ...identity,
        type: "minimum_age",
        provider: "self",
        ...documentProviderFields(input.accepted_providers),
        minimum_age: minimumAge,
      };
    }
    case "nationality": {
      if (input.provider !== "self" || !Array.isArray(input.allowed)) {
        throw new Error("nationality_invalid");
      }
      const allowed = input.allowed.map(normalizeIdentityCountryCode);
      if (allowed.some((country) => country === null)) {
        throw new Error("nationality_country_invalid");
      }
      const normalizedAllowed = allowed.filter((country): country is string => country !== null);
      return {
        ...identity,
        type: "nationality",
        provider: "self",
        ...documentProviderFields(input.accepted_providers),
        allowed: [...new Set(normalizedAllowed)],
      };
    }
    case "gender": {
      if (
        input.provider !== "self" ||
        !Array.isArray(input.allowed) ||
        input.allowed.length === 0 ||
        input.allowed.some((value) => value !== "M" && value !== "F")
      ) {
        throw new Error("gender_invalid");
      }
      const allowed = input.allowed.filter(
        (value): value is "M" | "F" => value === "M" || value === "F",
      );
      return {
        ...identity,
        type: "gender",
        provider: "self",
        ...documentProviderFields(input.accepted_providers),
        allowed: [...new Set(allowed)],
      };
    }
    case "wallet_score": {
      const minimumScore = input.minimum_score;
      if (
        input.provider !== "passport" ||
        typeof minimumScore !== "number" ||
        !Number.isFinite(minimumScore) ||
        minimumScore < 0 ||
        minimumScore > 100
      ) {
        throw new Error("wallet_score_invalid");
      }
      return {
        ...identity,
        type: "wallet_score",
        provider: "passport",
        minimum_score: minimumScore,
      };
    }
    case "erc721_holding": {
      const minCount = input.min_count;
      if (
        !isOneOf(input.chain_namespace, ["eip155:1", "eip155:8453"] as const) ||
        !isAddress(input.contract_address) ||
        (minCount != null &&
          (typeof minCount !== "number" ||
            !Number.isInteger(minCount) ||
            minCount < 1 ||
            minCount > 100))
      ) {
        throw new Error("erc721_holding_invalid");
      }
      return {
        ...identity,
        type: "erc721_holding",
        chain_namespace: input.chain_namespace,
        contract_address: input.contract_address,
        ...(typeof minCount === "number" ? { min_count: minCount } : {}),
      };
    }
    case "erc721_inventory_match": {
      const minQuantity = input.min_quantity;
      const match = input.match;
      if (
        input.provider !== "courtyard" ||
        !isOneOf(input.chain_namespace, ["eip155:1", "eip155:137"] as const) ||
        !isAddress(input.contract_address) ||
        typeof minQuantity !== "number" ||
        !Number.isInteger(minQuantity) ||
        minQuantity < 1 ||
        minQuantity > 100 ||
        !validInventoryMatch(match)
      ) {
        throw new Error("erc721_inventory_match_invalid");
      }
      return {
        ...identity,
        type: "erc721_inventory_match",
        provider: "courtyard",
        chain_namespace: input.chain_namespace,
        contract_address: input.contract_address,
        min_quantity: minQuantity,
        match,
      };
    }
    case "asset_balance":
      if (
        typeof input.asset_id !== "string" ||
        typeof input.min_amount_atomic !== "string" ||
        !/^\d+$/u.test(input.min_amount_atomic)
      ) {
        throw new Error("asset_balance_invalid");
      }
      return {
        ...identity,
        type: "asset_balance",
        asset_id: input.asset_id,
        min_amount_atomic: input.min_amount_atomic,
      };
    default:
      throw new Error("gate_atom_type_unsupported");
  }
}

function assertRequiredIdentityCapabilities(expression: GateExpressionNode<GateAtom>): void {
  if (expression.op === "gate") {
    if (
      expression.gate.type === "unique_human" ||
      expression.gate.type === "minimum_age" ||
      expression.gate.type === "nationality" ||
      expression.gate.type === "gender"
    ) {
      return;
    }
    return;
  }
  const childCapabilities = expression.children.map(requiredIdentityCapabilities);
  if (expression.op === "and") {
    const seen = new Set<string>();
    for (const capabilities of childCapabilities) {
      for (const capability of capabilities) {
        if (seen.has(capability)) throw new Error("gate_policy_identity_capability_repeated");
        seen.add(capability);
      }
    }
    return;
  }
}

function requiredIdentityCapabilities(expression: GateExpressionNode<GateAtom>): Set<string> {
  if (expression.op === "gate") {
    return expression.gate.type === "unique_human" ||
      expression.gate.type === "minimum_age" ||
      expression.gate.type === "nationality" ||
      expression.gate.type === "gender"
      ? new Set([expression.gate.type])
      : new Set();
  }
  const childCapabilities = expression.children.map(requiredIdentityCapabilities);
  if (expression.op === "or") {
    const first = childCapabilities[0] ?? new Set<string>();
    return new Set(
      [...first].filter((capability) => childCapabilities.every((child) => child.has(capability))),
    );
  }
  return new Set(childCapabilities.flatMap((child) => [...child]));
}

function readDocumentProviders(
  value: unknown,
): Array<(typeof DOCUMENT_PROOF_PROVIDERS)[number]> | null {
  if (value == null) return null;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => !isOneOf(item, DOCUMENT_PROOF_PROVIDERS))
  ) {
    throw new Error("document_providers_invalid");
  }
  return DOCUMENT_PROOF_PROVIDERS.filter((provider) => value.includes(provider));
}

function documentProviderFields(value: unknown): {
  accepted_providers?: Array<(typeof DOCUMENT_PROOF_PROVIDERS)[number]>;
} {
  const providers = readDocumentProviders(value);
  return providers == null ? {} : { accepted_providers: providers };
}

function validInventoryMatch(value: unknown): value is Record<string, string | string[]> {
  if (!isRecord(value) || typeof value.category !== "string") return false;
  const entries = Object.entries(value);
  if (entries.length < 2) return false;
  return entries.every(([, raw]) => {
    const values = Array.isArray(raw) ? raw : [raw];
    return (
      values.length > 0 &&
      values.length <= 10 &&
      values.every((item) => typeof item === "string" && item.trim())
    );
  });
}

function isAddress(value: unknown): value is string {
  return typeof value === "string" && /^0x[0-9a-f]{40}$/iu.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isOneOf<const T extends readonly unknown[]>(
  value: unknown,
  values: T,
): value is T[number] {
  return values.includes(value);
}
