import { sha256Hex } from "../gates-v2/sha256.ts";
import {
  type HandleEligibilitySnapshotV1,
  type HandleFamilyV1,
  type HandleFreePricingV1,
  type HandleFulfillmentKindV1,
  type HandleHashResultV1,
  handleEligibilitySnapshotPreimageV1,
} from "./sales-v2.ts";
import {
  isCanonicalSpacesRootV1,
  isCanonicalSpacesSubspaceLabelV1,
} from "./spaces-native-names.ts";

/**
 * Native Spaces issuance hash domains (spec 012 §5.3.13.6 and §5.3.13.12).
 * Every hash is SHA-256 of the compact UTF-8 JSON array (§5.1.8 byte rule).
 * The version-3 quote, reservation, and grant-finalize domains apply only to
 * `spaces_native_v1`; HNS keeps its version-2 domains. The quote tag is shared
 * with the HNS nationality quote, but the preimages cannot collide: this one
 * has fourteen members and a recipient member (ruling Q1).
 */

export type SpacesNetworkV1 = "mainnet" | "testnet4" | "regtest";

/** The persona's confirmed Spec 014 §12 Taproot assignment. The assignment id is private. */
export type SpacesRecipientBindingV1 = Readonly<{
  kind: "persona_taproot_v1";
  network: SpacesNetworkV1;
  taproot_assignment_id: string;
  script_pubkey_hex: string;
}>;

const SPACES_OPERATION_PREFIX = "issuance:spaces-native:";

const encoded = (preimage: readonly unknown[]): HandleHashResultV1 => {
  const json = JSON.stringify(preimage);
  return {
    bytes: new TextEncoder().encode(json).byteLength,
    preimage: json,
    sha256: sha256Hex(json),
  };
};

const identifier = (value: string): boolean =>
  value.length > 0 &&
  value === value.trim() &&
  ![...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
const requireIdentifier = (value: string, name: string): void => {
  if (!identifier(value)) throw new TypeError(`Invalid ${name}`);
};
const requireRevision = (value: number, name: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`Invalid ${name}`);
};
const requireDigest = (value: string, name: string): void => {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError(`Invalid ${name}`);
};
const requireNetwork = (network: string): void => {
  if (network !== "mainnet" && network !== "testnet4" && network !== "regtest") {
    throw new TypeError("Invalid Spaces network");
  }
};

/** Exact P2TR output script, lower-case hex: OP_1, push 32, x-only output key. */
export function isP2trOutputScriptHexV1(script: string): boolean {
  return /^5120[0-9a-f]{64}$/u.test(script);
}

export function spacesRecipientPreimageV1(recipient: SpacesRecipientBindingV1): readonly unknown[] {
  if (recipient.kind !== "persona_taproot_v1") throw new TypeError("Invalid Spaces recipient kind");
  requireNetwork(recipient.network);
  requireIdentifier(recipient.taproot_assignment_id, "Taproot assignment id");
  if (!isP2trOutputScriptHexV1(recipient.script_pubkey_hex)) {
    throw new TypeError("Invalid P2TR output script");
  }
  return [
    recipient.kind,
    recipient.network,
    recipient.taproot_assignment_id,
    recipient.script_pubkey_hex,
  ];
}

/** `spaces_native_v1` is the only Spaces fulfillment and never runs under family `hns`. */
const requireSpacesNative = (
  family: HandleFamilyV1,
  fulfillment: HandleFulfillmentKindV1,
): void => {
  if (family !== "spaces" || fulfillment !== "spaces_native_v1") {
    throw new TypeError("Spaces successor hashes require the spaces_native_v1 fulfillment");
  }
};
const requireSpacesKey = (namespaceRoot: string, handleLabel: string): void => {
  if (!isCanonicalSpacesRootV1(namespaceRoot)) throw new TypeError("Invalid canonical Spaces root");
  if (!isCanonicalSpacesSubspaceLabelV1(handleLabel)) throw new TypeError("invalid_handle");
};
const pricingPreimage = (pricing: HandleFreePricingV1): readonly unknown[] => [
  pricing.kind,
  pricing.pricing_id,
  pricing.pricing_revision,
  pricing.pricing_hash,
  pricing.atomic_amount,
];

/**
 * The checked Spaces sibling of the HNS activation hash. The funding
 * confirmation is encoded literally so any change moves the hash; admission
 * separately requires the owner's literal `true` (§5.3.13.3 item 5).
 */
export function handleSpacesSaleNamespaceActivationHash(input: {
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  community_id: string;
  network: SpacesNetworkV1;
  canonical_root: string;
  namespace_authority_reference: string;
  namespace_authority_generation: number;
  operator_assignment_id: string;
  operator_assignment_generation: number;
  operator_funding_terms_confirmed: boolean;
}): HandleHashResultV1 {
  requireIdentifier(input.sale_namespace_activation_id, "sale activation id");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  requireIdentifier(input.community_id, "community id");
  requireNetwork(input.network);
  if (!isCanonicalSpacesRootV1(input.canonical_root)) {
    throw new TypeError("Invalid canonical Spaces root");
  }
  requireIdentifier(input.namespace_authority_reference, "namespace authority reference");
  requireRevision(input.namespace_authority_generation, "namespace authority generation");
  requireIdentifier(input.operator_assignment_id, "operator assignment id");
  requireRevision(input.operator_assignment_generation, "operator assignment generation");
  return encoded([
    "pirate-handle-spaces-sale-namespace-activation-v1",
    input.sale_namespace_activation_id,
    input.sale_namespace_activation_generation,
    input.community_id,
    "spaces",
    input.canonical_root,
    input.network,
    [
      "verified_namespace_v1",
      input.namespace_authority_reference,
      input.namespace_authority_generation,
    ],
    [
      "spaces_operator_assignment_v1",
      input.operator_assignment_id,
      input.operator_assignment_generation,
    ],
    ["spaces_operator_funding_confirm_v1", input.operator_funding_terms_confirmed],
  ]);
}

export function handleSpacesQuoteV3Hash(input: {
  quote_id: string;
  offering_id: string;
  offering_revision: number;
  offering_hash: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  fulfillment_kind: HandleFulfillmentKindV1;
  owner_persona_id: string;
  recipient: SpacesRecipientBindingV1;
  family: HandleFamilyV1;
  namespace_root: string;
  handle_label: string;
  pricing: HandleFreePricingV1;
  eligibility: HandleEligibilitySnapshotV1;
  quoted_at: string;
  expires_at: string;
}): HandleHashResultV1 {
  requireSpacesNative(input.family, input.fulfillment_kind);
  requireIdentifier(input.quote_id, "quote id");
  requireIdentifier(input.offering_id, "offering id");
  requireRevision(input.offering_revision, "offering revision");
  requireDigest(input.offering_hash, "offering hash");
  requireIdentifier(input.sale_namespace_activation_id, "sale activation id");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  requireIdentifier(input.owner_persona_id, "owner persona id");
  requireSpacesKey(input.namespace_root, input.handle_label);
  requireIdentifier(input.quoted_at, "quote instant");
  requireIdentifier(input.expires_at, "quote expiry");
  return encoded([
    "pirate-handle-quote-v3",
    input.quote_id,
    input.offering_id,
    input.offering_revision,
    input.offering_hash,
    [input.sale_namespace_activation_id, input.sale_namespace_activation_generation],
    [input.fulfillment_kind],
    input.owner_persona_id,
    spacesRecipientPreimageV1(input.recipient),
    [input.family, input.namespace_root, input.handle_label],
    pricingPreimage(input.pricing),
    handleEligibilitySnapshotPreimageV1(input.eligibility),
    input.quoted_at,
    input.expires_at,
  ]);
}

export function handleSpacesReservationV3Hash(input: {
  reservation_id: string;
  quote_id: string;
  quote_hash: string;
  offering_id: string;
  offering_hash: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  fulfillment_kind: HandleFulfillmentKindV1;
  owner_persona_id: string;
  recipient: SpacesRecipientBindingV1;
  family: HandleFamilyV1;
  namespace_root: string;
  handle_label: string;
  reserved_at: string;
  expires_at: string;
}): HandleHashResultV1 {
  requireSpacesNative(input.family, input.fulfillment_kind);
  for (const name of ["reservation_id", "quote_id", "offering_id", "owner_persona_id"] as const) {
    requireIdentifier(input[name], name);
  }
  requireDigest(input.quote_hash, "quote hash");
  requireDigest(input.offering_hash, "offering hash");
  requireIdentifier(input.sale_namespace_activation_id, "sale activation id");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  requireSpacesKey(input.namespace_root, input.handle_label);
  requireIdentifier(input.reserved_at, "reservation instant");
  requireIdentifier(input.expires_at, "reservation expiry");
  return encoded([
    "pirate-handle-reservation-v3",
    input.reservation_id,
    input.quote_id,
    input.quote_hash,
    input.offering_id,
    input.offering_hash,
    [input.sale_namespace_activation_id, input.sale_namespace_activation_generation],
    [input.fulfillment_kind],
    input.owner_persona_id,
    spacesRecipientPreimageV1(input.recipient),
    [input.family, input.namespace_root, input.handle_label],
    input.reserved_at,
    input.expires_at,
  ]);
}

/** Computed at claim submission; the later final-evidence reference is not a member. */
export function handleSpacesGrantFinalizeV3Hash(input: {
  claim_id: string;
  reservation_id: string;
  reservation_hash: string;
  offering_id: string;
  offering_hash: string;
  sale_namespace_activation_id: string;
  sale_namespace_activation_generation: number;
  fulfillment_kind: HandleFulfillmentKindV1;
  family: HandleFamilyV1;
  namespace_root: string;
  handle_label: string;
  owner_persona_id: string;
  recipient: SpacesRecipientBindingV1;
  issuance_operation_id: string;
  claim_request_hash: string;
}): HandleHashResultV1 {
  requireSpacesNative(input.family, input.fulfillment_kind);
  for (const name of ["claim_id", "reservation_id", "offering_id", "owner_persona_id"] as const) {
    requireIdentifier(input[name], name);
  }
  requireDigest(input.reservation_hash, "reservation hash");
  requireDigest(input.offering_hash, "offering hash");
  requireDigest(input.claim_request_hash, "claim request hash");
  requireIdentifier(input.sale_namespace_activation_id, "sale activation id");
  requireRevision(input.sale_namespace_activation_generation, "sale activation generation");
  requireSpacesKey(input.namespace_root, input.handle_label);
  requireIdentifier(input.issuance_operation_id, "issuance operation id");
  if (!input.issuance_operation_id.startsWith(SPACES_OPERATION_PREFIX)) {
    throw new TypeError("Spaces grants require a Spaces issuance operation");
  }
  return encoded([
    "pirate-handle-grant-finalize-v3",
    input.claim_id,
    input.reservation_id,
    input.reservation_hash,
    input.offering_id,
    input.offering_hash,
    [input.sale_namespace_activation_id, input.sale_namespace_activation_generation],
    [input.fulfillment_kind],
    [input.family, input.namespace_root, input.handle_label],
    input.owner_persona_id,
    spacesRecipientPreimageV1(input.recipient),
    input.issuance_operation_id,
    input.claim_request_hash,
  ]);
}

/** One issuance operation per claim; the HNS hosted form is unchanged. */
export function handleIssuanceOperationIdV1(input: {
  fulfillment_kind: HandleFulfillmentKindV1;
  claim_id: string;
}): string {
  requireIdentifier(input.claim_id, "claim id");
  switch (input.fulfillment_kind) {
    case "hosted_persona_v1":
      return `issuance:hns-hosted:${input.claim_id}`;
    case "spaces_native_v1":
      return `${SPACES_OPERATION_PREFIX}${input.claim_id}`;
    case "delegated_zone_v1":
      throw new TypeError("delegated_zone_v1 issuance is reserved");
  }
}

export type SpacesSuccessorHashDomainV1 = "quote_v3" | "reservation_v3" | "grant_finalize_v3";

/** Member positions per domain, keyed by tag; a Map keeps untrusted tags off the prototype. */
const SUCCESSOR_SHAPES: ReadonlyMap<
  string,
  Readonly<{
    domain: SpacesSuccessorHashDomainV1;
    arity: number;
    fulfillment: number;
    key: number;
    recipient: number;
  }>
> = new Map([
  [
    "pirate-handle-quote-v3",
    { domain: "quote_v3", arity: 14, fulfillment: 6, key: 9, recipient: 8 },
  ],
  [
    "pirate-handle-reservation-v3",
    { domain: "reservation_v3", arity: 13, fulfillment: 7, key: 10, recipient: 9 },
  ],
  [
    "pirate-handle-grant-finalize-v3",
    { domain: "grant_finalize_v3", arity: 13, fulfillment: 7, key: 8, recipient: 10 },
  ],
]);

/**
 * Structural decode of a stored successor preimage. It admits only a compact
 * Spaces version-3 array whose fulfillment is `spaces_native_v1`, whose key
 * family is `spaces`, and which carries a Taproot recipient. The HNS
 * version-2 domains and the thirteen-member HNS nationality quote never decode.
 */
export function classifySpacesSuccessorPreimageV1(
  preimage: string,
): SpacesSuccessorHashDomainV1 | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(preimage);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || JSON.stringify(parsed) !== preimage) return null;
  const shape = typeof parsed[0] === "string" ? SUCCESSOR_SHAPES.get(parsed[0]) : undefined;
  if (shape === undefined || parsed.length !== shape.arity) return null;
  const fulfillment: unknown = parsed[shape.fulfillment];
  const key: unknown = parsed[shape.key];
  const recipient: unknown = parsed[shape.recipient];
  return Array.isArray(fulfillment) &&
    fulfillment.length === 1 &&
    fulfillment[0] === "spaces_native_v1" &&
    Array.isArray(key) &&
    key.length === 3 &&
    key[0] === "spaces" &&
    Array.isArray(recipient) &&
    recipient.length === 4 &&
    recipient[0] === "persona_taproot_v1"
    ? shape.domain
    : null;
}
