import { applyMachineEvent, defineMoneyFlowMachine } from "../money/state-machine";

export type StorySettlementStepState =
  | "planned"
  | "reserving"
  | "failed_prebroadcast"
  | "prepared"
  | "broadcast"
  | "mined"
  | "confirmed"
  | "reverted"
  | "replaced"
  | "reconciliation_required";

export type Hex = `0x${string}`;
export type StorySettlementReceiptEvidence = {
  status: "success" | "reverted";
  blockNumber: bigint;
  blockHash: Hex;
};
export type StorySettlementStepSnapshot = {
  state: StorySettlementStepState;
  version: number;
  nonce: number | null;
  signedTransactionStored: boolean;
  transactionHash: Hex | null;
  receipt: StorySettlementReceiptEvidence | null;
};
export type StorySettlementStepTransition = {
  expectedVersion: number;
  to: StorySettlementStepState;
  nonce?: number;
  signedTransactionStored?: boolean;
  transactionHash?: Hex;
  receipt?: StorySettlementReceiptEvidence;
};

export const STORY_SETTLEMENT_STEP_ALLOWED_TRANSITIONS: Readonly<
  Record<StorySettlementStepState, readonly StorySettlementStepState[]>
> = {
  planned: ["reserving"],
  reserving: ["prepared", "failed_prebroadcast"],
  failed_prebroadcast: ["reserving"],
  prepared: ["broadcast", "reconciliation_required"],
  broadcast: ["broadcast", "mined", "reverted", "replaced", "reconciliation_required"],
  mined: ["mined", "confirmed", "broadcast", "reconciliation_required"],
  confirmed: [],
  reverted: [],
  replaced: [],
  reconciliation_required: ["broadcast", "mined", "confirmed", "reverted", "replaced"],
};

export function canTransitionStorySettlementStep(
  from: StorySettlementStepState,
  to: StorySettlementStepState,
): boolean {
  return STORY_SETTLEMENT_STEP_ALLOWED_TRANSITIONS[from].includes(to);
}
export function isTerminalStorySettlementStepState(state: StorySettlementStepState): boolean {
  return state === "confirmed" || state === "reverted" || state === "replaced";
}
function assertNonce(nonce: number): void {
  if (!Number.isSafeInteger(nonce) || nonce < 0)
    throw new Error("nonce_must_be_non_negative_safe_integer");
}
function assertHash(hash: Hex, field: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`${field}_must_be_bytes32`);
}
function assertReceipt(receipt: StorySettlementReceiptEvidence): void {
  if (receipt.blockNumber < 0n) throw new Error("receipt_block_number_must_be_non_negative");
  assertHash(receipt.blockHash, "receipt_block_hash");
}
function assertSnapshot(snapshot: StorySettlementStepSnapshot): void {
  if (
    !Number.isSafeInteger(snapshot.version) ||
    snapshot.version < 1 ||
    snapshot.version === Number.MAX_SAFE_INTEGER
  ) {
    throw new Error("step_version_must_be_incrementable_positive_integer");
  }
  if (snapshot.nonce != null) assertNonce(snapshot.nonce);
  if (snapshot.transactionHash) assertHash(snapshot.transactionHash, "transaction_hash");
  if (snapshot.receipt) assertReceipt(snapshot.receipt);
  if (snapshot.state !== "planned" && snapshot.nonce == null)
    throw new Error(`${snapshot.state}_step_requires_nonce`);
  const signedStates = [
    "prepared",
    "broadcast",
    "mined",
    "confirmed",
    "reverted",
    "replaced",
    "reconciliation_required",
  ];
  if (
    signedStates.includes(snapshot.state) &&
    (!snapshot.signedTransactionStored || !snapshot.transactionHash)
  ) {
    throw new Error(`${snapshot.state}_step_requires_durable_signed_transaction`);
  }
  if (
    ["planned", "reserving", "failed_prebroadcast"].includes(snapshot.state) &&
    (snapshot.signedTransactionStored || snapshot.transactionHash || snapshot.receipt)
  ) {
    throw new Error(`${snapshot.state}_step_cannot_have_signed_evidence`);
  }
  if (
    (snapshot.state === "mined" || snapshot.state === "confirmed") &&
    snapshot.receipt?.status !== "success"
  ) {
    throw new Error(`${snapshot.state}_step_requires_successful_receipt`);
  }
  if (snapshot.state === "reverted" && snapshot.receipt?.status !== "reverted")
    throw new Error("reverted_step_requires_reverted_receipt");
}

function reduceStorySettlementStep(
  current: StorySettlementStepSnapshot,
  transition: StorySettlementStepTransition,
): StorySettlementStepSnapshot {
  if (transition.expectedVersion !== current.version)
    throw new Error("story_settlement_step_version_conflict");
  if (!canTransitionStorySettlementStep(current.state, transition.to))
    throw new Error(`illegal_story_settlement_step_transition:${current.state}:${transition.to}`);
  if (transition.nonce != null) assertNonce(transition.nonce);
  if (current.nonce != null && transition.nonce != null && transition.nonce !== current.nonce)
    throw new Error("story_settlement_step_nonce_is_immutable");
  if (transition.transactionHash) assertHash(transition.transactionHash, "transaction_hash");
  if (
    current.transactionHash &&
    transition.transactionHash &&
    transition.transactionHash !== current.transactionHash
  )
    throw new Error("story_settlement_step_transaction_hash_is_immutable");
  if (current.signedTransactionStored && transition.signedTransactionStored === false)
    throw new Error("story_settlement_signed_transaction_cannot_be_removed");
  if (transition.receipt) assertReceipt(transition.receipt);
  const nonce = transition.nonce ?? current.nonce;
  const signedTransactionStored =
    transition.signedTransactionStored ?? current.signedTransactionStored;
  const transactionHash = transition.transactionHash ?? current.transactionHash;
  let receipt = transition.receipt ?? current.receipt;
  if (transition.to === "reserving") {
    if (current.state === "planned" && nonce == null)
      throw new Error("reserving_step_requires_nonce");
    if (current.state === "failed_prebroadcast" && nonce !== current.nonce)
      throw new Error("prebroadcast_retry_must_reuse_nonce");
  }
  if (transition.to === "failed_prebroadcast" && (signedTransactionStored || transactionHash))
    throw new Error("prebroadcast_failure_cannot_have_signed_transaction");
  if (
    ["prepared", "broadcast", "mined", "confirmed", "reverted", "replaced"].includes(
      transition.to,
    ) &&
    (nonce == null || !signedTransactionStored || !transactionHash)
  )
    throw new Error(`${transition.to}_step_requires_durable_signed_transaction`);
  if (transition.to === "broadcast" || transition.to === "replaced") receipt = null;
  if ((transition.to === "mined" || transition.to === "confirmed") && receipt?.status !== "success")
    throw new Error(`${transition.to}_step_requires_successful_receipt`);
  if (transition.to === "reverted" && receipt?.status !== "reverted")
    throw new Error("reverted_step_requires_reverted_receipt");
  const next = {
    state: transition.to,
    version: current.version + 1,
    nonce,
    signedTransactionStored,
    transactionHash,
    receipt,
  };
  return next;
}

export const storySettlementStepMachine = defineMoneyFlowMachine<
  StorySettlementStepSnapshot,
  StorySettlementStepTransition,
  StorySettlementStepState
>({
  stateOf: (state) => state.state,
  allowedTransitions: STORY_SETTLEMENT_STEP_ALLOWED_TRANSITIONS,
  assertInvariants: assertSnapshot,
  reduce: reduceStorySettlementStep,
});

export function transitionStorySettlementStep(
  current: StorySettlementStepSnapshot,
  transition: StorySettlementStepTransition,
): StorySettlementStepSnapshot {
  return applyMachineEvent(storySettlementStepMachine, current, transition);
}
