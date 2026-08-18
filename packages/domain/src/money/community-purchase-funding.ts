/**
 * M3a evidence-only reducer for the buyer-funding leg. It does not own an
 * outbound signer nonce or a releasable reservation; the concrete M3 journal
 * composes those later rather than treating this snapshot as the whole flow.
 */
import {
  AMBIGUOUS,
  type AmbiguousFailure,
  LEGACY,
  type LegacyFailure,
  type ReclaimableFailure,
} from "./failure-fence";
import type { ServerDerivedIdempotencyKey } from "./interpreter-contract";
import {
  type AllowedTransitionTable,
  defineMoneyFlowMachine,
  rejectTransition,
  type TransitionRejection,
  transitionMachineEvent,
} from "./state-machine";

declare const communityPurchaseOperationIdBrand: unique symbol;
declare const communityPurchaseDerivedIdBrand: unique symbol;
declare const communityPurchaseAtomicAmountBrand: unique symbol;

export type CommunityPurchaseOperationId = ServerDerivedIdempotencyKey & {
  readonly [communityPurchaseOperationIdBrand]: "CommunityPurchaseOperationId";
};

export type CommunityPurchaseDerivedId = string & {
  readonly [communityPurchaseDerivedIdBrand]: "CommunityPurchaseDerivedId";
};

export type CommunityPurchaseAtomicAmount = bigint & {
  readonly [communityPurchaseAtomicAmountBrand]: "CommunityPurchaseAtomicAmount";
};

export type CommunityPurchaseFundingState =
  | "planned"
  | "confirming"
  | "confirmed"
  | "reverted"
  | "reclaimable_failed"
  | "reconciliation_required";

export type EvmAddress = `0x${string}`;
export type Bytes32 = `0x${string}`;

export type CommunityPurchaseFundingExpectation = {
  readonly chainId: number;
  readonly tokenContract: EvmAddress;
  readonly tokenDecimals: 6;
  readonly sender: EvmAddress;
  readonly recipient: EvmAddress;
  readonly amountAtomic: CommunityPurchaseAtomicAmount;
  readonly requiredConfirmations: number;
};

/**
 * Authoritative chain evidence combines the receipt with decoded transaction
 * intent. A successful receipt also binds the exact ERC-20 Transfer log; a
 * reverted receipt proves the attempted call but cannot contain that log.
 */
export type CommunityPurchaseFundingEvidence = {
  readonly receiptStatus: "success" | "reverted";
  readonly chainId: number;
  readonly tokenContract: EvmAddress;
  readonly sender: EvmAddress;
  readonly recipient: EvmAddress;
  readonly amountAtomic: CommunityPurchaseAtomicAmount;
  readonly transactionHash: Bytes32;
  readonly blockNumber: number;
  readonly blockHash: Bytes32;
  /** A successful transfer must name its ERC-20 log; a reverted receipt has no log. */
  readonly logIndex: number | null;
  /** Digest of the server-side chain observation; freshness is journal-fenced. */
  readonly observationId: Bytes32;
  readonly observedHeadBlockNumber: number;
  readonly observedHeadBlockHash: Bytes32;
};

export type CommunityPurchaseConfirmedReceiptIdentity = Readonly<{
  readonly transactionHash: Bytes32;
  readonly blockNumber: number;
  readonly blockHash: Bytes32;
  readonly logIndex: number;
}>;

type CommunityPurchaseFundingBase = {
  readonly operationId: CommunityPurchaseOperationId;
  readonly communityId: string;
  readonly quoteId: string;
  readonly purchaseId: string;
  readonly policyVersion: number;
  readonly expected: CommunityPurchaseFundingExpectation;
  readonly version: number;
  readonly updatedAt: number;
  /** First confirmed receipt identity; retained forever to pin append-only receipt history. */
  readonly confirmedReceiptIdentity: CommunityPurchaseConfirmedReceiptIdentity | null;
};

type UnfailedFundingSnapshot = CommunityPurchaseFundingBase & {
  readonly failure: null;
  readonly failureReason: null;
  readonly reconciliationEvidence: null;
};

export type CommunityPurchaseFundingSnapshot =
  | (UnfailedFundingSnapshot & {
      readonly state: "planned";
      readonly fundingEvidence: null;
    })
  | (UnfailedFundingSnapshot & {
      readonly state: "confirming";
      readonly fundingEvidence: CommunityPurchaseFundingEvidence;
    })
  | (UnfailedFundingSnapshot & {
      readonly state: "confirmed";
      readonly fundingEvidence: CommunityPurchaseFundingEvidence;
    })
  | (UnfailedFundingSnapshot & {
      readonly state: "reverted";
      readonly fundingEvidence: CommunityPurchaseFundingEvidence;
    })
  | (CommunityPurchaseFundingBase & {
      readonly state: "reclaimable_failed";
      readonly fundingEvidence: null;
      readonly failure: ReclaimableFailure;
      readonly failureReason: string;
      readonly reconciliationEvidence: null;
    })
  | (CommunityPurchaseFundingBase & {
      readonly state: "reconciliation_required";
      readonly fundingEvidence: CommunityPurchaseFundingEvidence | null;
      readonly failure: AmbiguousFailure | LegacyFailure;
      readonly failureReason: string;
      readonly reconciliationEvidence: CommunityPurchaseFundingEvidence | null;
    });

export type CommunityPurchaseFundingPlan = {
  readonly communityId: string;
  readonly quoteId: string;
  readonly purchaseId: string;
  readonly policyVersion: number;
  readonly expected: CommunityPurchaseFundingExpectation;
  readonly now: number;
};

type EventHeader = {
  readonly expectedVersion: number;
  readonly at: number;
};

export type CommunityPurchaseFundingEvent =
  | (EventHeader & {
      readonly type: "funding_evidence_observed";
      readonly evidence: CommunityPurchaseFundingEvidence;
    })
  | (EventHeader & {
      readonly type: "reclaimable_failure_recorded";
      readonly failure: ReclaimableFailure;
      readonly reason: string;
    })
  | (EventHeader & {
      readonly type: "reclaimable_failure_retried";
    })
  | (EventHeader & {
      readonly type: "reconciliation_required";
      readonly failure: AmbiguousFailure | LegacyFailure;
      readonly reason: string;
    })
  | (EventHeader & {
      readonly type: "reconciliation_resolved";
      readonly evidence: CommunityPurchaseFundingEvidence;
    })
  | (EventHeader & {
      /**
       * Silent checkout abandonment. The server-owned deadline derives from the
       * immutable plan expiry; `at` comes from the database clock. Carries no
       * transaction identity and never proves that no value moved, so the only
       * honest outcome is legacy ambiguity — never reclaimable or terminal.
       */
      readonly type: "planned_observation_window_expired";
      readonly policyVersion: number;
      readonly observationDeadline: number;
    });

export const COMMUNITY_PURCHASE_FUNDING_ALLOWED_TRANSITIONS: AllowedTransitionTable<CommunityPurchaseFundingState> =
  {
    planned: [
      "confirming",
      "confirmed",
      "reverted",
      "reclaimable_failed",
      "reconciliation_required",
    ],
    confirming: ["confirming", "confirmed", "reverted", "reconciliation_required"],
    confirmed: ["confirmed", "reconciliation_required"],
    reverted: ["reverted", "reconciliation_required"],
    reclaimable_failed: ["planned"],
    reconciliation_required: ["confirming", "confirmed", "reverted"],
  };

function assertBusinessId(value: string, field: string): void {
  if (value.length === 0 || value !== value.trim()) throw new Error(`${field}_must_be_canonical`);
}

function canonicalSegment(value: string, field: string): string {
  assertBusinessId(value, field);
  return encodeURIComponent(value);
}

function assertPolicyVersion(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("policy_version_must_be_positive_safe_integer");
  }
}

export function communityPurchaseAtomicAmount(value: bigint): CommunityPurchaseAtomicAmount {
  if (typeof value !== "bigint" || value < 1n) {
    throw new Error("community_purchase_amount_must_be_positive");
  }
  return value as CommunityPurchaseAtomicAmount;
}

export function deriveCommunityPurchaseOperationId(input: {
  readonly communityId: string;
  readonly quoteId: string;
  readonly purchaseId: string;
  readonly policyVersion: number;
}): CommunityPurchaseOperationId {
  assertPolicyVersion(input.policyVersion);
  const identity = [
    canonicalSegment(input.communityId, "community_id"),
    canonicalSegment(input.quoteId, "quote_id"),
    canonicalSegment(input.purchaseId, "purchase_id"),
    String(input.policyVersion),
  ].join(":");
  return `money:v1:community_purchase:${identity}` as CommunityPurchaseOperationId;
}

export type CommunityPurchaseDerivedRowKind = "purchase" | "entitlement" | "allocation" | "receipt";

export function deriveCommunityPurchaseRowId(
  operationId: CommunityPurchaseOperationId,
  kind: CommunityPurchaseDerivedRowKind,
  ordinal = 0,
): CommunityPurchaseDerivedId {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) {
    throw new Error("derived_row_ordinal_must_be_non_negative_safe_integer");
  }
  return `money-row:v1:${kind}:${ordinal}:${encodeURIComponent(operationId)}` as CommunityPurchaseDerivedId;
}

function isCanonicalAddress(value: string): value is EvmAddress {
  return /^0x[0-9a-f]{40}$/.test(value);
}

function isBytes32(value: string): value is Bytes32 {
  return /^0x[0-9a-f]{64}$/.test(value);
}

function invalidEvidence(
  expected: CommunityPurchaseFundingExpectation,
  evidence: CommunityPurchaseFundingEvidence,
): string | null {
  if (!["success", "reverted"].includes(evidence.receiptStatus as string)) {
    return "funding_evidence_receipt_status_invalid";
  }
  if (!Number.isSafeInteger(evidence.chainId) || evidence.chainId < 1) {
    return "funding_evidence_chain_id_invalid";
  }
  if (!isCanonicalAddress(evidence.tokenContract)) return "funding_evidence_token_invalid";
  if (!isCanonicalAddress(evidence.sender)) return "funding_evidence_sender_invalid";
  if (!isCanonicalAddress(evidence.recipient)) return "funding_evidence_recipient_invalid";
  if (typeof evidence.amountAtomic !== "bigint" || evidence.amountAtomic < 1n) {
    return "funding_evidence_amount_invalid";
  }
  if (!isBytes32(evidence.transactionHash)) return "funding_evidence_transaction_hash_invalid";
  if (!isBytes32(evidence.blockHash)) return "funding_evidence_block_hash_invalid";
  if (!isBytes32(evidence.observationId)) return "funding_observation_id_invalid";
  if (!isBytes32(evidence.observedHeadBlockHash)) return "funding_observed_head_hash_invalid";
  if (!Number.isSafeInteger(evidence.blockNumber) || evidence.blockNumber < 0) {
    return "funding_evidence_block_number_invalid";
  }
  if (
    evidence.logIndex !== null &&
    (!Number.isSafeInteger(evidence.logIndex) || evidence.logIndex < 0)
  ) {
    return "funding_evidence_log_index_invalid";
  }
  if (evidence.receiptStatus === "success" && evidence.logIndex === null) {
    return "successful_funding_requires_log_identity";
  }
  if (evidence.receiptStatus === "reverted" && evidence.logIndex !== null) {
    return "reverted_funding_cannot_have_transfer_log";
  }
  if (
    !Number.isSafeInteger(evidence.observedHeadBlockNumber) ||
    evidence.observedHeadBlockNumber < evidence.blockNumber
  ) {
    return "funding_observed_head_block_invalid";
  }
  if (evidence.chainId !== expected.chainId) return "funding_evidence_chain_mismatch";
  if (evidence.tokenContract !== expected.tokenContract) return "funding_evidence_token_mismatch";
  if (evidence.sender !== expected.sender) return "funding_evidence_sender_mismatch";
  if (evidence.recipient !== expected.recipient) return "funding_evidence_recipient_mismatch";
  if (evidence.amountAtomic !== expected.amountAtomic) return "funding_evidence_amount_mismatch";
  return null;
}

function assertExpectation(expected: CommunityPurchaseFundingExpectation): void {
  if (!Number.isSafeInteger(expected.chainId) || expected.chainId < 1) {
    throw new Error("expected_chain_id_invalid");
  }
  if (!isCanonicalAddress(expected.tokenContract)) throw new Error("expected_token_invalid");
  if (expected.tokenDecimals !== 6) throw new Error("expected_token_decimals_invalid");
  if (!isCanonicalAddress(expected.sender)) throw new Error("expected_sender_invalid");
  if (!isCanonicalAddress(expected.recipient)) throw new Error("expected_recipient_invalid");
  if (typeof expected.amountAtomic !== "bigint" || expected.amountAtomic < 1n) {
    throw new Error("expected_amount_atomic_invalid");
  }
  if (!Number.isSafeInteger(expected.requiredConfirmations) || expected.requiredConfirmations < 1) {
    throw new Error("required_confirmations_invalid");
  }
}

function assertFailureReason(reason: string): void {
  if (reason.length === 0 || reason !== reason.trim()) {
    throw new Error("failure_reason_must_be_canonical");
  }
}

function confirmationDepth(evidence: CommunityPurchaseFundingEvidence): number {
  return evidence.observedHeadBlockNumber - evidence.blockNumber + 1;
}

function receiptIdentity(
  evidence: CommunityPurchaseFundingEvidence,
): CommunityPurchaseConfirmedReceiptIdentity | null {
  return evidence.receiptStatus === "success" && evidence.logIndex !== null
    ? {
        transactionHash: evidence.transactionHash,
        blockNumber: evidence.blockNumber,
        blockHash: evidence.blockHash,
        logIndex: evidence.logIndex,
      }
    : null;
}

function sameReceiptIdentity(
  left: CommunityPurchaseConfirmedReceiptIdentity,
  right: CommunityPurchaseConfirmedReceiptIdentity,
): boolean {
  return (
    left.transactionHash === right.transactionHash &&
    left.blockNumber === right.blockNumber &&
    left.blockHash === right.blockHash &&
    left.logIndex === right.logIndex
  );
}

function confirmedReceiptIdentityChanged(
  current: CommunityPurchaseFundingSnapshot,
  evidence: CommunityPurchaseFundingEvidence,
): boolean {
  const next = receiptIdentity(evidence);
  return (
    current.confirmedReceiptIdentity !== null &&
    next !== null &&
    !sameReceiptIdentity(current.confirmedReceiptIdentity, next)
  );
}

function assertSnapshot(snapshot: CommunityPurchaseFundingSnapshot): void {
  assertBusinessId(snapshot.communityId, "community_id");
  assertBusinessId(snapshot.quoteId, "quote_id");
  assertBusinessId(snapshot.purchaseId, "purchase_id");
  assertPolicyVersion(snapshot.policyVersion);
  assertExpectation(snapshot.expected);
  if (!Number.isSafeInteger(snapshot.version) || snapshot.version < 1) {
    throw new Error("funding_version_must_be_positive_safe_integer");
  }
  if (snapshot.version === Number.MAX_SAFE_INTEGER) {
    throw new Error("funding_version_must_be_incrementable");
  }
  if (!Number.isSafeInteger(snapshot.updatedAt) || snapshot.updatedAt < 0) {
    throw new Error("funding_updated_at_invalid");
  }
  const expectedOperationId = deriveCommunityPurchaseOperationId(snapshot);
  if (snapshot.operationId !== expectedOperationId) {
    throw new Error("community_purchase_operation_identity_mismatch");
  }
  if (snapshot.fundingEvidence) {
    const invalid = invalidEvidence(snapshot.expected, snapshot.fundingEvidence);
    if (invalid) throw new Error(invalid);
  }
  if (snapshot.reconciliationEvidence) {
    const invalid = invalidEvidence(snapshot.expected, snapshot.reconciliationEvidence);
    if (invalid) throw new Error(invalid);
    if (
      snapshot.fundingEvidence &&
      snapshot.reconciliationEvidence.transactionHash !== snapshot.fundingEvidence.transactionHash
    ) {
      throw new Error("reconciliation_evidence_effect_identity_changed");
    }
  }
  if (snapshot.confirmedReceiptIdentity !== null) {
    const identity = snapshot.confirmedReceiptIdentity;
    if (
      !isBytes32(identity.transactionHash) ||
      !isBytes32(identity.blockHash) ||
      !Number.isSafeInteger(identity.blockNumber) ||
      identity.blockNumber < 0 ||
      !Number.isSafeInteger(identity.logIndex) ||
      identity.logIndex < 0
    ) {
      throw new Error("confirmed_receipt_identity_invalid");
    }
  }
  if (snapshot.state === "planned") {
    if (
      snapshot.confirmedReceiptIdentity !== null ||
      snapshot.fundingEvidence !== null ||
      snapshot.failure !== null ||
      snapshot.failureReason !== null ||
      snapshot.reconciliationEvidence !== null
    ) {
      throw new Error("planned_funding_requires_empty_evidence_and_failure");
    }
    return;
  }
  if (snapshot.state === "confirming") {
    if (
      snapshot.fundingEvidence === null ||
      snapshot.failure !== null ||
      snapshot.failureReason !== null ||
      snapshot.reconciliationEvidence !== null
    ) {
      throw new Error("confirming_funding_shape_invalid");
    }
    if (confirmationDepth(snapshot.fundingEvidence) >= snapshot.expected.requiredConfirmations) {
      throw new Error("confirming_funding_cannot_have_finality");
    }
    return;
  }
  if (snapshot.state === "confirmed") {
    const currentIdentity = receiptIdentity(snapshot.fundingEvidence);
    if (
      snapshot.fundingEvidence === null ||
      snapshot.failure !== null ||
      snapshot.failureReason !== null ||
      snapshot.reconciliationEvidence !== null ||
      currentIdentity === null ||
      snapshot.confirmedReceiptIdentity === null ||
      !sameReceiptIdentity(snapshot.confirmedReceiptIdentity, currentIdentity) ||
      snapshot.fundingEvidence.receiptStatus !== "success" ||
      confirmationDepth(snapshot.fundingEvidence) < snapshot.expected.requiredConfirmations
    ) {
      throw new Error("confirmed_funding_requires_final_success");
    }
    return;
  }
  if (snapshot.state === "reverted") {
    if (
      snapshot.fundingEvidence === null ||
      snapshot.failure !== null ||
      snapshot.failureReason !== null ||
      snapshot.reconciliationEvidence !== null ||
      snapshot.fundingEvidence.receiptStatus !== "reverted" ||
      confirmationDepth(snapshot.fundingEvidence) < snapshot.expected.requiredConfirmations
    ) {
      throw new Error("reverted_funding_requires_final_revert");
    }
    return;
  }
  if (snapshot.state === "reclaimable_failed") {
    assertFailureReason(snapshot.failureReason);
    if (
      snapshot.fundingEvidence !== null ||
      snapshot.failure._tag !== "reclaimable" ||
      snapshot.reconciliationEvidence !== null
    ) {
      throw new Error("reclaimable_failure_requires_reclaimable_fence");
    }
    return;
  }
  assertFailureReason(snapshot.failureReason);
  if (!["ambiguous", "legacy"].includes(snapshot.failure._tag as string)) {
    throw new Error("reconciliation_requires_ambiguous_or_legacy_fence");
  }
}

/** Re-check a snapshot decoded from durable storage before interpreting it. */
export function assertCommunityPurchaseFundingSnapshot(
  snapshot: CommunityPurchaseFundingSnapshot,
): void {
  assertSnapshot(snapshot);
}

export function createCommunityPurchaseFunding(
  plan: CommunityPurchaseFundingPlan,
): CommunityPurchaseFundingSnapshot {
  const snapshot: CommunityPurchaseFundingSnapshot = {
    state: "planned",
    operationId: deriveCommunityPurchaseOperationId(plan),
    communityId: plan.communityId,
    quoteId: plan.quoteId,
    purchaseId: plan.purchaseId,
    policyVersion: plan.policyVersion,
    expected: plan.expected,
    version: 1,
    updatedAt: plan.now,
    confirmedReceiptIdentity: null,
    fundingEvidence: null,
    failure: null,
    failureReason: null,
    reconciliationEvidence: null,
  };
  assertSnapshot(snapshot);
  return snapshot;
}

function validateEventHeader(
  current: CommunityPurchaseFundingSnapshot,
  event: EventHeader,
): TransitionRejection | null {
  if (event.expectedVersion !== current.version) {
    return rejectTransition("community_purchase_funding_version_conflict");
  }
  if (!Number.isSafeInteger(event.at) || event.at < current.updatedAt) {
    return rejectTransition("community_purchase_funding_event_time_invalid");
  }
  return null;
}

function hasSameEffectIdentity(
  current: CommunityPurchaseFundingEvidence,
  next: CommunityPurchaseFundingEvidence,
): boolean {
  return current.transactionHash === next.transactionHash;
}

function evidenceNeedsReconciliation(
  current: CommunityPurchaseFundingEvidence,
  next: CommunityPurchaseFundingEvidence,
): boolean {
  return (
    current.blockNumber !== next.blockNumber ||
    current.blockHash !== next.blockHash ||
    current.logIndex !== next.logIndex ||
    current.receiptStatus !== next.receiptStatus ||
    (current.observedHeadBlockNumber === next.observedHeadBlockNumber &&
      current.observedHeadBlockHash !== next.observedHeadBlockHash) ||
    next.observedHeadBlockNumber < current.observedHeadBlockNumber
  );
}

function stateForEvidence(
  current: CommunityPurchaseFundingSnapshot,
  evidence: CommunityPurchaseFundingEvidence,
  at: number,
): CommunityPurchaseFundingSnapshot {
  const base = {
    ...current,
    version: current.version + 1,
    updatedAt: at,
    fundingEvidence: evidence,
    failure: null,
    failureReason: null,
    reconciliationEvidence: null,
    confirmedReceiptIdentity:
      evidence.receiptStatus === "success" &&
      confirmationDepth(evidence) >= current.expected.requiredConfirmations
        ? (current.confirmedReceiptIdentity ?? receiptIdentity(evidence))
        : current.confirmedReceiptIdentity,
  } as const;
  if (confirmationDepth(evidence) < current.expected.requiredConfirmations) {
    return { ...base, state: "confirming" };
  }
  return {
    ...base,
    state: evidence.receiptStatus === "success" ? "confirmed" : "reverted",
  };
}

function requireReconciliation(
  current: CommunityPurchaseFundingSnapshot,
  input: {
    readonly at: number;
    readonly failure: AmbiguousFailure | LegacyFailure;
    readonly reason: string;
    readonly evidence?: CommunityPurchaseFundingEvidence;
  },
): CommunityPurchaseFundingSnapshot {
  return {
    ...current,
    state: "reconciliation_required",
    version: current.version + 1,
    updatedAt: input.at,
    failure: input.failure,
    failureReason: input.reason,
    reconciliationEvidence: input.evidence ?? null,
  };
}

function reduceCommunityPurchaseFunding(
  current: CommunityPurchaseFundingSnapshot,
  event: CommunityPurchaseFundingEvent,
): CommunityPurchaseFundingSnapshot | TransitionRejection {
  const invalidHeader = validateEventHeader(current, event);
  if (invalidHeader) return invalidHeader;

  if (event.type === "funding_evidence_observed") {
    if (
      current.state !== "planned" &&
      current.state !== "confirming" &&
      current.state !== "confirmed" &&
      current.state !== "reverted"
    ) {
      return rejectTransition(`funding_evidence_not_allowed_from:${current.state}`);
    }
    const invalid = invalidEvidence(current.expected, event.evidence);
    if (invalid) return rejectTransition(invalid);
    if (current.state !== "planned") {
      if (!hasSameEffectIdentity(current.fundingEvidence, event.evidence)) {
        return rejectTransition("funding_evidence_effect_identity_changed");
      }
      if (current.fundingEvidence.observationId === event.evidence.observationId) {
        return rejectTransition("funding_observation_not_fresh");
      }
      if (evidenceNeedsReconciliation(current.fundingEvidence, event.evidence)) {
        return requireReconciliation(current, {
          at: event.at,
          failure: AMBIGUOUS,
          reason: "funding_block_identity_changed",
          evidence: event.evidence,
        });
      }
    }
    return stateForEvidence(current, event.evidence, event.at);
  }

  if (event.type === "reclaimable_failure_recorded") {
    if (current.state !== "planned") {
      return rejectTransition(`reclaimable_failure_not_allowed_from:${current.state}`);
    }
    if (event.failure._tag !== "reclaimable") {
      return rejectTransition("reclaimable_failure_requires_reclaimable_fence");
    }
    if (event.reason.length === 0 || event.reason !== event.reason.trim()) {
      return rejectTransition("failure_reason_must_be_canonical");
    }
    return {
      ...current,
      state: "reclaimable_failed",
      version: current.version + 1,
      updatedAt: event.at,
      failure: event.failure,
      failureReason: event.reason,
    };
  }

  if (event.type === "reclaimable_failure_retried") {
    if (current.state !== "reclaimable_failed") {
      return rejectTransition(`reclaimable_retry_not_allowed_from:${current.state}`);
    }
    return {
      ...current,
      state: "planned",
      version: current.version + 1,
      updatedAt: event.at,
      fundingEvidence: null,
      failure: null,
      failureReason: null,
      reconciliationEvidence: null,
    };
  }

  if (event.type === "planned_observation_window_expired") {
    if (current.state !== "planned") {
      return rejectTransition(`planned_observation_expiry_not_allowed_from:${current.state}`);
    }
    if (event.policyVersion !== current.policyVersion) {
      return rejectTransition("planned_observation_expiry_policy_mismatch");
    }
    if (!Number.isSafeInteger(event.observationDeadline) || event.observationDeadline < 1) {
      return rejectTransition("planned_observation_expiry_deadline_invalid");
    }
    if (event.at < event.observationDeadline) {
      return rejectTransition("planned_observation_expiry_not_due");
    }
    return requireReconciliation(current, {
      at: event.at,
      failure: LEGACY,
      reason: "planned_observation_window_expired",
    });
  }

  if (event.type === "reconciliation_required") {
    if (
      current.state !== "confirming" &&
      current.state !== "confirmed" &&
      current.state !== "reverted"
    ) {
      return rejectTransition(`reconciliation_not_allowed_from:${current.state}`);
    }
    if (!["ambiguous", "legacy"].includes(event.failure._tag as string)) {
      return rejectTransition("reconciliation_requires_ambiguous_or_legacy_fence");
    }
    if (event.reason.length === 0 || event.reason !== event.reason.trim()) {
      return rejectTransition("failure_reason_must_be_canonical");
    }
    return requireReconciliation(current, event);
  }

  if (current.state !== "reconciliation_required") {
    return rejectTransition(`reconciliation_resolution_not_allowed_from:${current.state}`);
  }
  const invalid = invalidEvidence(current.expected, event.evidence);
  if (invalid) return rejectTransition(invalid);
  if (current.fundingEvidence && !hasSameEffectIdentity(current.fundingEvidence, event.evidence)) {
    return rejectTransition("funding_evidence_effect_identity_changed");
  }
  if (
    event.evidence.observationId === current.fundingEvidence?.observationId ||
    event.evidence.observationId === current.reconciliationEvidence?.observationId
  ) {
    return rejectTransition("reconciliation_observation_not_fresh");
  }
  if (current.confirmedReceiptIdentity !== null && event.evidence.receiptStatus !== "success") {
    return rejectTransition("confirmed_receipt_outcome_changed");
  }
  if (confirmedReceiptIdentityChanged(current, event.evidence)) {
    return rejectTransition("confirmed_receipt_identity_changed");
  }
  return stateForEvidence(current, event.evidence, event.at);
}

const communityPurchaseFundingMachine = defineMoneyFlowMachine<
  CommunityPurchaseFundingSnapshot,
  CommunityPurchaseFundingEvent,
  CommunityPurchaseFundingState
>({
  stateOf: (snapshot) => snapshot.state,
  allowedTransitions: COMMUNITY_PURCHASE_FUNDING_ALLOWED_TRANSITIONS,
  assertInvariants: assertSnapshot,
  reduce: reduceCommunityPurchaseFunding,
});

export function canTransitionCommunityPurchaseFunding(
  from: CommunityPurchaseFundingState,
  to: CommunityPurchaseFundingState,
): boolean {
  return COMMUNITY_PURCHASE_FUNDING_ALLOWED_TRANSITIONS[from].includes(to);
}

export function transitionCommunityPurchaseFunding(
  current: CommunityPurchaseFundingSnapshot,
  event: CommunityPurchaseFundingEvent,
): CommunityPurchaseFundingSnapshot | TransitionRejection {
  return transitionMachineEvent(communityPurchaseFundingMachine, current, event);
}
