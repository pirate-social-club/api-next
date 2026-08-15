import type { AtomEvaluation, RequiredActionNode } from "./policy";

export type Erc721HoldingAtom = {
  readonly type: "erc721_holding";
  readonly chain_namespace: string;
  readonly contract_address: string;
  readonly min_count?: number;
};

export type Erc721HoldingFacts = {
  readonly quantity: number | null;
  readonly unavailable: boolean;
};

export type Erc721InventoryMatchAtom = {
  readonly type: "erc721_inventory_match";
  readonly provider: "courtyard";
  readonly chain_namespace: string;
  readonly contract_address: string;
  readonly min_quantity: number;
  readonly match: Record<string, string | string[]>;
};

export type Erc721InventoryFacts = {
  readonly matchedQuantity: number;
  readonly matchedTokenKeys: readonly string[];
  readonly unavailable: boolean;
};

export type Erc721HoldingEvaluation = AtomEvaluation;

export type Erc721InventoryEvaluation = AtomEvaluation & {
  readonly matchedTokenKeys: readonly string[];
};

/** Evaluate normalized chain ownership facts; the RPC adapter stays outside domain. */
export function evaluateErc721HoldingAtom(input: {
  readonly atom: Erc721HoldingAtom;
  readonly facts: Erc721HoldingFacts;
}): Erc721HoldingEvaluation {
  const minimumQuantity = input.atom.min_count ?? 1;
  if (input.facts.unavailable) {
    return { outcome: "provider_unavailable", passed: false, requiredAction: null };
  }
  if ((input.facts.quantity ?? 0) >= minimumQuantity) {
    return { outcome: "passed", passed: true, requiredAction: null };
  }
  return {
    outcome: "action_required",
    passed: false,
    requiredAction: holdingAction(input.atom, minimumQuantity),
  };
}

/** Evaluate normalized inventory facts while retaining the provider's token keys. */
export function evaluateErc721InventoryMatchAtom(input: {
  readonly atom: Erc721InventoryMatchAtom;
  readonly facts: Erc721InventoryFacts;
}): Erc721InventoryEvaluation {
  const matchedTokenKeys = [...input.facts.matchedTokenKeys];
  if (input.facts.unavailable) {
    return {
      outcome: "provider_unavailable",
      passed: false,
      requiredAction: null,
      matchedTokenKeys,
    };
  }
  if (input.facts.matchedQuantity >= input.atom.min_quantity) {
    return { outcome: "passed", passed: true, requiredAction: null, matchedTokenKeys };
  }
  return {
    outcome: "action_required",
    passed: false,
    requiredAction: inventoryAction(input.atom),
    matchedTokenKeys,
  };
}

export const evaluateErc721HoldingGate = evaluateErc721HoldingAtom;
export const evaluateErc721InventoryGate = evaluateErc721InventoryMatchAtom;

function holdingAction(atom: Erc721HoldingAtom, minimumQuantity: number): RequiredActionNode {
  return {
    kind: "action",
    provider: "wallet",
    capability: "erc721_holding",
    chain_namespace: atom.chain_namespace,
    contract_address: atom.contract_address,
    min_quantity: minimumQuantity,
  };
}

function inventoryAction(atom: Erc721InventoryMatchAtom): RequiredActionNode {
  return {
    kind: "action",
    provider: "wallet",
    capability: "erc721_inventory_match",
    chain_namespace: atom.chain_namespace,
    contract_address: atom.contract_address,
    min_quantity: atom.min_quantity,
  };
}
